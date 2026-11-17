/** Offline JavaScript language service. Source is parsed and type checked, never executed. */
import ts from './vendor-typescript.mjs';
import libraries from './vendor-typescript-libs.mjs';
import {buildLanguageProject} from './script-language-model.mjs';

const display = parts => ts.displayPartsToString(parts || []);
const documentation = value => display(value?.documentation);
const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, Number.isFinite(value) ? value : upper));
const normalize = name => {
  const parts = [];
  for (const part of String(name).replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
};

function tokenAt(sourceFile, position) {
  // The compiler owns tokenization, including regex literals and template substitutions.
  return ts.getTokenAtPosition(sourceFile, Math.max(0, Math.min(position, sourceFile.end)));
}
function identifierSpan(sourceFile, position, offset, source) {
  const absolute = position + offset;
  for (const token of [tokenAt(sourceFile, absolute), tokenAt(sourceFile, Math.max(offset, absolute - 1))]) {
    if (!token || !(ts.isIdentifier(token) || ts.isPrivateIdentifier(token))) continue;
    const from = token.getStart(sourceFile) - offset, to = token.end - offset;
    if (from < 0 || from > position || to < position || to > source.length) continue;
    // The compiler token includes private-name markers and Unicode escapes.
    // Compare decoded names, but replace the full original source token.
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.slice(from, position));
    scanner.scan();
    return {from, to, prefix:position === from ? '' : scanner.getTokenValue()};
  }
  let from = position, to = position;
  while (from > 0) {
    const previous = source.codePointAt(from - 1);
    const width = previous >= 0xdc00 && previous <= 0xdfff && from > 1 ? 2 : 1;
    if (!ts.isIdentifierPart(source.codePointAt(from - width), ts.ScriptTarget.Latest)) break;
    from -= width;
  }
  while (to < source.length) {
    const point = source.codePointAt(to);
    if (!ts.isIdentifierPart(point, ts.ScriptTarget.Latest)) break;
    to += point > 0xffff ? 2 : 1;
  }
  return {from, to, prefix:source.slice(from, position)};
}
function enclosingMember(token, position) {
  for (let node = token; node; node = node.parent) {
    if (ts.isPropertyAccessExpression(node) && position >= node.expression.end) {
      if (position <= node.name.end || (!node.name.getWidth() && !node.getSourceFile().text.slice(node.end, position).trim())) return node;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && position >= node.argumentExpression.pos && position <= node.argumentExpression.end) return node;
  }
  return null;
}
function literalValue(text, quote) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, quote + text + quote);
  scanner.scan();
  return scanner.getTokenValue();
}
function literalSpan(sourceFile, position, offset, source) {
  const candidates = [tokenAt(sourceFile, position), tokenAt(sourceFile, Math.max(offset, position - 1))];
  for (const node of candidates) {
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) continue;
    const start = node.getStart(sourceFile), quote = sourceFile.text[start];
    if (position <= start || position > node.end || !['"', "'", '`'].includes(quote)) continue;
    const closed = !node.isUnterminated && sourceFile.text[node.end - 1] === quote && node.end > start + 1;
    // An unfinished template can consume the virtual wrapper's closing braces;
    // its editable range still ends at the user's source boundary.
    const from = start + 1 - offset, to = Math.min(source.length, node.end - (closed ? 1 : 0) - offset);
    if (from < 0 || position - offset > to) continue;
    const raw = source.slice(from, position - offset);
    return {from, to, prefix:literalValue(raw, quote), quote};
  }
  return null;
}
function callName(sourceFile, span, position, fallback) {
  let exact = null, enclosing = null;
  const visit = node => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      if (Math.abs(node.arguments.pos - span.start) <= 1) exact = node;
      if (node.expression.end < position && node.pos <= position && position <= node.end + 1) enclosing = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return (exact || enclosing)?.expression.getText(sourceFile) || fallback;
}
function visibleUserDeclaration(symbol, project) {
  return symbol?.declarations?.some(node => normalize(node.getSourceFile().fileName) === project.fileName &&
    node.getStart() >= project.offset && node.getStart() < project.offset + project.sourceLength);
}

export function createScriptIntelligence() {
  const files = new Map(), snapshots = new Map(), versions = new Map();
  const libraryFiles = new Map(Object.entries(libraries).map(([name, text]) => [normalize(name), String(text)]));
  const settings = {
    target:ts.ScriptTarget.ES2023, module:ts.ModuleKind.ESNext, moduleResolution:ts.ModuleResolutionKind.Bundler,
    allowJs:true, checkJs:true, noEmit:true, allowNonTsExtensions:true, strictNullChecks:false,
    skipLibCheck:true, types:[], lib:['lib.es2023.d.ts', 'lib.webworker.d.ts', 'lib.webworker.iterable.d.ts', 'lib.webworker.asynciterable.d.ts']
  };
  const read = name => files.get(normalize(name)) ?? libraryFiles.get(normalize(name));
  let projectVersion = 0, disposed = false;
  const host = {
    getCompilationSettings:() => settings,
    getCurrentDirectory:() => '/',
    getDefaultLibFileName:() => '/lib.es2023.d.ts',
    getScriptFileNames:() => [...files.keys()],
    getProjectVersion:() => String(projectVersion),
    getScriptVersion:name => String(versions.get(normalize(name)) || 0),
    getScriptKind:name => /\.jsx?$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    getScriptSnapshot(name) {
      name = normalize(name);
      const text = read(name);
      if (text === undefined) return undefined;
      if (!snapshots.has(name)) snapshots.set(name, ts.ScriptSnapshot.fromString(text));
      return snapshots.get(name);
    },
    fileExists:name => read(name) !== undefined,
    readFile:read,
    useCaseSensitiveFileNames:() => true,
    getNewLine:() => '\n',
    realpath:normalize,
    directoryExists:name => {
      const prefix = normalize(name).replace(/\/$/, '') + '/';
      return [...files.keys(), ...libraryFiles.keys()].some(file => file.startsWith(prefix));
    },
    getDirectories:name => {
      const prefix = normalize(name).replace(/\/$/, '') + '/';
      return [...new Set([...files.keys(), ...libraryFiles.keys()].filter(file => file.startsWith(prefix))
        .map(file => file.slice(prefix.length)).filter(file => file.includes('/')).map(file => prefix + file.split('/')[0]))];
    },
    readDirectory:() => [...files.keys(), ...libraryFiles.keys()]
  };
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (!name.startsWith('.') && !name.startsWith('/')) return undefined;
    const resolved = ts.resolveModuleName(name, containingFile, settings, host).resolvedModule;
    return resolved && host.fileExists(resolved.resolvedFileName) ? resolved : undefined;
  });
  const service = ts.createLanguageService(host, ts.createDocumentRegistry(true, '/'));
  function update(source, context) {
    if (disposed) throw new Error('コード解析は終了しています。');
    source = String(source ?? '');
    const project = buildLanguageProject(source, context || {});
    const next = new Map(Object.entries(project.files).map(([name, text]) => [normalize(name), String(text)]));
    let changed = false;
    for (const name of files.keys()) if (!next.has(name)) {
      files.delete(name); snapshots.delete(name); versions.delete(name); changed = true;
    }
    for (const [name, text] of next) if (files.get(name) !== text) {
      files.set(name, text); snapshots.delete(name); versions.set(name, (versions.get(name) || 0) + 1); changed = true;
    }
    if (changed) projectVersion++;
    return {...project, fileName:normalize(project.fileName), source, sourceLength:source.length};
  }
  function detail(project, position, name) {
    const value = service.getCompletionEntryDetails(project.fileName, position + project.offset, name, {}, undefined,
      {includeCompletionsForModuleExports:false, includeCompletionsWithInsertText:true}, undefined);
    return value ? {label:name, signature:display(value.displayParts), description:documentation(value), kind:value.kind} : null;
  }
  function analyze(source, position = String(source ?? '').length, {explicit = false, context = {}} = {}) {
    const project = update(source, context);
    position = clamp(position, 0, project.sourceLength);
    const absolute = position + project.offset;
    const program = service.getProgram(), sourceFile = program.getSourceFile(project.fileName), checker = program.getTypeChecker();
    const token = tokenAt(sourceFile, absolute), literal = literalSpan(sourceFile, absolute, project.offset, project.source);
    const span = literal || identifierSpan(sourceFile, position, project.offset, project.source);
    // TS escapes quote/backslash characters in literal entries, but leaves ${
    // unchanged in backticks. Keep dictionary keys literal instead of creating
    // executable template substitutions when the completion is accepted.
    const literalText = text => literal?.quote === '`' ? ts.escapeTemplateSubstitution(text) : text;
    const member = enclosingMember(token, absolute) || enclosingMember(ts.findPrecedingToken(absolute, sourceFile), absolute);
    const preferences = {includeCompletionsForModuleExports:false, includeCompletionsWithInsertText:true,
      includeCompletionsWithSnippetText:false, includeCompletionsWithClassMemberSnippets:false};
    let completion = null;
    if (explicit || span.prefix || member || literal) {
      const info = service.getCompletionsAtPosition(project.fileName, absolute, preferences);
      if (info) {
        const memberType = member && checker.getTypeAtLocation(member.expression);
        const unknownMember = memberType && (memberType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
        const symbols = new Map(checker.getSymbolsInScope(token, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias).map(symbol => [symbol.getName(), symbol]));
        const entries = unknownMember ? [] : info.entries.filter(entry => {
          if (entry.hasAction || entry.source) return false;
          if (entry.name.startsWith('__') && symbols.has(entry.name) && !visibleUserDeclaration(symbols.get(entry.name), project)) return false;
          const name = literal ? literalValue(literalText(entry.name), literal.quote) : entry.name;
          return !span.prefix || name.toLocaleLowerCase().startsWith(span.prefix.toLocaleLowerCase());
        });
        entries.sort((a, b) => a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name));
        const items = entries.map((entry, index) => {
          const replacement = entry.replacementSpan || info.optionalReplacementSpan;
          let from = span.from, to = span.to;
          if (replacement && replacement.start >= project.offset && replacement.start + replacement.length <= project.offset + project.sourceLength) {
            from = replacement.start - project.offset; to = replacement.start + replacement.length - project.offset;
            // Identifier acceptance replaces the suffix to the right of the cursor too.
            if (!literal && from === span.from) to = Math.max(to, span.to);
          }
          const details = index < 24 ? detail(project, position, entry.name) : null;
          return {label:entry.name, insertText:literalText(entry.insertText || entry.name), kind:entry.kind,
            signature:details?.signature || entry.name, description:details?.description || '', from, to};
        });
        if (items.length) completion = {from:span.from, to:span.to, prefix:span.prefix,
          receiver:member?.expression.getText(sourceFile) || null, items};
      }
    }
    let signature = null;
    const signatures = service.getSignatureHelpItems(project.fileName, absolute, {triggerReason:{kind:'invoked'}});
    if (signatures?.items.length) {
      const item = signatures.items[signatures.selectedItemIndex] || signatures.items[0];
      const prefix = display(item.prefixDisplayParts), plainName = prefix.slice(0, prefix.indexOf('('));
      const name = callName(sourceFile, signatures.applicableSpan, absolute, plainName);
      const parameters = item.parameters.map(parameter => ({name:parameter.name, signature:display(parameter.displayParts), description:documentation(parameter)}));
      signature = {name, signature:name + prefix.slice(Math.max(0, prefix.indexOf('('))) +
        parameters.map(parameter => parameter.signature).join(display(item.separatorDisplayParts)) + display(item.suffixDisplayParts),
        description:documentation(item), argument:signatures.argumentIndex, parameters};
    }
    let quickInfo = null;
    const quick = service.getQuickInfoAtPosition(project.fileName, Math.max(project.offset, absolute - (position ? 1 : 0)));
    if (quick && quick.textSpan.start >= project.offset && quick.textSpan.start < project.offset + project.sourceLength) {
      quickInfo = {text:display(quick.displayParts), description:documentation(quick), kind:quick.kind,
        from:quick.textSpan.start - project.offset, to:quick.textSpan.start + quick.textSpan.length - project.offset};
    }
    const diagnostics = service.getSyntacticDiagnostics(project.fileName)
      // Missing delimiters can be reported at the generated wrapper's closing
      // braces or EOF. They still belong to the user's unfinished source, so
      // keep them and clamp their spans to its end rather than hiding them.
      .filter(item => item.start !== undefined && item.start >= project.offset)
      .map(item => ({from:clamp(item.start - project.offset, 0, project.sourceLength),
        to:clamp(item.start + (item.length || 0) - project.offset, 0, project.sourceLength),
        code:item.code, message:ts.flattenDiagnosticMessageText(item.messageText, '\n'), severity:item.category === ts.DiagnosticCategory.Error ? 'error' : 'warning'}));
    return {completion, signature, quickInfo, diagnostics, engine:{name:'TypeScript', version:ts.version}};
  }
  return {analyze, details(source, position, name, {context = {}} = {}) {
    const project = update(source, context);
    return detail(project, clamp(position, 0, project.sourceLength), name);
  }, dispose() {disposed = true; service.dispose(); files.clear(); snapshots.clear(); versions.clear();}};
}

// Synchronous compatibility for pure-module callers/tests. The UI imports only
// the lightweight worker client; the compiler is never loaded into its main thread.
let compatibilityService;
const compatibility = () => compatibilityService ||= createScriptIntelligence();
export function completionContext(source, position = String(source).length, options = {}) {
  return compatibility().analyze(source, position, options).completion;
}
export function signatureHelp(source, position = String(source).length, options = {}) {
  return compatibility().analyze(source, position, options).signature;
}
export function scriptCompletions(source, options = {}) {
  const result = completionContext(source, String(source).length, options);
  return result?.items.map(item => ({label:item.label, insert:item.insertText.slice(result.prefix.length)})) || [];
}
