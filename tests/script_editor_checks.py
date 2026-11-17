"""Native textarea contracts against the actual JavaScript language Worker."""
from playwright.sync_api import expect


def check_editor(page, area, root, passed, capture):
    suggestions = root.locator('.source-suggestions')

    def analysed():
        expect(root).to_have_attribute('data-intelligence', 'ready', timeout=30000)

    def offer(source, name):
        area.fill(source)
        analysed()
        option = suggestions.get_by_role('option', name=name, exact=True)
        expect(option).to_be_visible()
        return option

    area.fill('pm.env')
    analysed()
    expect(suggestions).to_be_visible()
    expect(suggestions.get_by_role('option', name='environment', exact=True)).to_be_visible()
    area.press('Tab')
    expect(area).to_have_value('pm.environment')
    expect(suggestions).to_be_hidden()
    area.press('Control+z')
    expect(area).to_have_value('pm.env')
    passed('Tab completes without indentation and native Undo restores the previous source')

    offer('pm.response.js', 'json')
    area.press('Enter')
    expect(area).to_have_value('pm.response.json')
    passed('nested API completion accepts Enter without inserting a newline')

    area.fill('pm.response.jsoonn')
    area.evaluate('e=>e.setSelectionRange(14,14)')
    area.press('Control+Space')
    analysed()
    expect(suggestions.get_by_role('option', name='json', exact=True)).to_be_visible()
    area.press('Enter')
    expect(area).to_have_value('pm.response.json')
    passed('completion replaces the entire identifier when the caret is inside it')

    for source in ['// pm.', '/* pm.', '"pm.', "'pm.", '`pm.']:
        area.fill(source)
        analysed()
        expect(suggestions).to_be_hidden()
    passed('comments and string/template literals do not show API completion')

    offer('const accessToken = "test-only";\naccess', 'accessToken')
    area.press('Tab')
    expect(area).to_have_value('const accessToken = "test-only";\naccessToken')
    passed('a local variable resolved by the language service is offered and inserted')

    offer('const account = {profile: {displayName: "Ada"}, score: 4};\nconst {profile: currentProfile} = account;\ncurrentProfile.dis', 'displayName')
    area.press('Tab')
    expect(area).to_have_value('const account = {profile: {displayName: "Ada"}, score: 4};\nconst {profile: currentProfile} = account;\ncurrentProfile.displayName')
    passed('nested object types survive aliasing and destructuring in member completion')

    offer('const record = {outerOnly: true};\n{ const record = {innerOnly: 1}; record.', 'innerOnly')
    expect(suggestions.get_by_role('option', name='outerOnly', exact=True)).to_have_count(0)
    area.fill('{ const privateRecord = {hidden: 1}; }\nprivateRec')
    analysed()
    expect(suggestions.get_by_role('option', name='privateRecord', exact=True)).to_have_count(0)
    passed('block scope and shadowed variables select the actual binding without leaking closed-scope names')

    offer('const rows = [{name: "Ada", score: 4}];\nrows.map(row => row.sc', 'score')
    offer('const rows = [{name: "Ada", score: 4}];\nconst names = rows.map(row => row.name);\nnames[0].toU', 'toUpperCase')
    passed('array callbacks infer element members and chained results retain standard string methods')

    offer('class Base { baseMethod() { return 1; } }\nclass Report extends Base { title = "weekly"; render(prefix) { return prefix + this.title; } }\nconst report = new Report();\nreport.re', 'render')
    offer('class Base { baseMethod() { return 1; } }\nclass Report extends Base { title = "weekly"; }\nconst report = new Report();\nreport.ba', 'baseMethod')
    offer('class Report { title = "weekly"; render() { return this.ti', 'title')
    passed('class instances, inherited methods and this members are resolved from syntax and types')

    offer('function makeRecord() { return {profile: {displayName: "Ada"}}; }\nconst result = makeRecord();\nresult.profile.dis', 'displayName')
    offer('async function loadRecord() { return {message: "ready"}; }\nconst result = await loadRecord();\nresult.mes', 'message')
    passed('function return values and awaited async return values provide inferred members')

    offer('const record = {displayName: "Ada"};\nconst label = `Name: ${record.dis', 'displayName')
    offer('throw new Error("analysis must not execute this");\nconst record = {displayName: "Ada"};\nrecord.dis', 'displayName')
    passed('template interpolations are parsed as code and suggestions do not execute the edited source')

    area.fill('/** @param {{name: string, count: number}} item @param {number} multiplier */\nfunction summarize(item, multiplier) { return item.name.repeat(multiplier); }\nsummarize({name: "Ada", count: 1}, ')
    analysed()
    expect(root.locator('.source-signature')).to_contain_text('summarize(')
    expect(root.locator('.source-signature')).to_contain_text('multiplier')
    expect(root.locator('.source-signature')).to_contain_text('number')
    expect(root.locator('.source-signature')).to_contain_text('引数 2')
    passed('JSDoc enriches a user-defined function signature and identifies its current argument')

    area.fill('vars.set("token", ')
    analysed()
    expect(root.locator('.source-signature')).to_contain_text('set(')
    expect(root.locator('.source-signature')).to_contain_text('value')
    expect(root.locator('.source-signature')).to_contain_text('引数 2')
    capture('script-arguments')
    passed('function signature displays the active argument')

    area.fill('pm.')
    analysed()
    before = area.input_value()
    area.press('Shift+Tab')
    expect(area).to_have_value(before)
    expect(area).not_to_be_focused()
    expect(suggestions).to_be_hidden()
    passed('Shift+Tab leaves the editor without accepting a suggestion')

    area.focus()
    area.fill('pm.')
    prevented = area.evaluate('''e=>{
      e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'あ'}));
      const event=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:false,cancelable:true});
      e.dispatchEvent(event);return event.defaultPrevented;
    }''')
    assert not prevented
    expect(suggestions).to_be_hidden()
    area.evaluate("e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))")
    passed('IME composition input and Enter are not intercepted by completion')

    area.fill('pm.')
    observed = area.evaluate('''e=>{
      let seen;
      const listener=event=>{seen=event.defaultPrevented;event.stopPropagation();};
      e.addEventListener('keydown',listener,{once:true});
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
      return seen;
    }''')
    assert observed is False
    expect(area).to_have_value('pm.')
    passed('Ctrl+Enter is left available to the application command handler')

    area.fill('')
    area.press('Control+Space')
    analysed()
    expect(suggestions).to_be_visible()
    area.press('ArrowDown')
    selected = suggestions.locator('[aria-selected=true]')
    assert selected.count() == 1
    assert area.get_attribute('aria-activedescendant') == selected.get_attribute('id')
    area.press('Escape')
    expect(suggestions).to_be_hidden()
    assert area.get_attribute('aria-activedescendant') is None
    passed('Ctrl+Space, arrow selection and Escape keep accessible active-option state')

    pending = area.evaluate('''e=>{
      e.value='pm.response.js';e.setSelectionRange(e.value.length,e.value.length);
      e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'s'}));
      const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
      e.dispatchEvent(event);return event.defaultPrevented;
    }''')
    assert pending is False
    area.fill('const older = {oldOnly: 1}; older.')
    area.fill('const latest = {newOnly: true}; latest.')
    analysed()
    expect(suggestions.get_by_role('option', name='newOnly', exact=True)).to_be_visible()
    expect(suggestions.get_by_role('option', name='oldOnly', exact=True)).to_have_count(0)
    area.fill('pm.')
    area.press('Shift+Tab')
    expect(area).not_to_be_focused()
    expect(suggestions).to_be_hidden()
    expect(root).to_have_attribute('data-intelligence', 'idle')
    passed('pending analysis never consumes Enter and stale edits or blur cannot reopen an old completion list')

    # Page navigation moves the caret without input or an arrow-key event. An
    # existing member list must not remain attached to the previous expression.
    prefix = 'const jumpRecord = {jumpMember: 1}; jumpRecord.ju'
    for key in ['PageUp', 'PageDown']:
        source = '\n' * 80 + prefix if key == 'PageUp' else prefix + '\n' * 80
        position = len(source) if key == 'PageUp' else len(prefix)
        area.fill(source)
        area.evaluate('(element, position) => element.setSelectionRange(position, position)', position)
        area.press('Control+Space')
        analysed()
        expect(suggestions.get_by_role('option', name='jumpMember', exact=True)).to_be_visible()
        area.press(key)
        assert area.evaluate('element => element.selectionStart') != position, key
        analysed()
        expect(suggestions.get_by_role('option', name='jumpMember', exact=True)).not_to_be_visible()
        expect(area).to_have_value(source)
    passed('PageUp and PageDown invalidate completion at the previous caret position without changing source')

    offer('console.l', 'log')
    suggestions.get_by_role('option', name='log', exact=True).click()
    expect(area).to_have_value('console.log')
    expect(area).to_be_focused()
    passed('pointer completion preserves textarea focus')

    offer('const rows = [{name: "Ada", score: 4}];\n// 入力データの各要素を処理\nrows.map(row => row.', 'score')
    expect(root.locator('.syntax-keyword').first).to_be_visible()
    expect(root.locator('.syntax-string').first).to_be_visible()
    expect(root.locator('.syntax-comment').first).to_be_visible()
    expect(suggestions).to_be_visible()
    capture('script-completion-desktop')
    for width, height in [(390,844),(320,720)]:
        page.set_viewport_size({'width':width,'height':height})
        area.focus()
        area.press('Control+End')
        area.press('Control+Space')
        analysed()
        expect(suggestions).to_be_visible()
        box=suggestions.bounding_box()
        assert box and box['x']>=0 and box['x']+box['width']<=width+1, box
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        capture('script-completion-'+str(width))
    page.set_viewport_size({'width':1440,'height':1000})
    passed('syntax colors and completion popup remain visible without overflow at 320–1440px')
