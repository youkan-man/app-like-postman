"""Shared keyboard/IME contracts for the native textarea component and application."""
from playwright.sync_api import expect


def check_editor(page, area, root, passed, capture):
    suggestions = root.locator('.source-suggestions')
    area.fill('pm.env')
    expect(suggestions).to_be_visible()
    expect(suggestions.get_by_role('option', name='environment', exact=True)).to_be_visible()
    area.press('Tab')
    expect(area).to_have_value('pm.environment')
    expect(suggestions).to_be_hidden()
    area.press('Control+z')
    expect(area).to_have_value('pm.env')
    passed('Tab completes without indentation and native Undo restores the previous source')

    area.fill('pm.response.js')
    area.press('Enter')
    expect(area).to_have_value('pm.response.json')
    passed('nested API completion accepts Enter without inserting a newline')

    area.fill('pm.response.jsoonn')
    area.evaluate('e=>e.setSelectionRange(14,14)')
    area.press('Control+Space')
    area.press('Enter')
    expect(area).to_have_value('pm.response.json')
    passed('completion replaces the entire identifier when the caret is inside it')

    for source in ['// pm.', '/* pm.', '"pm.', "'pm.", '`pm.']:
        area.fill(source)
        expect(suggestions).to_be_hidden()
    passed('comments and string/template literals do not show API completion')

    area.fill('const accessToken = "test-only";\naccess')
    expect(suggestions.get_by_role('option', name='accessToken', exact=True)).to_be_visible()
    area.press('Tab')
    expect(area).to_have_value('const accessToken = "test-only";\naccessToken')
    passed('lexically declared local variable is offered and inserted')

    area.fill('vars.set("token", ')
    expect(root.locator('.source-signature')).to_contain_text('vars.set(name, value)')
    expect(root.locator('.source-signature')).to_contain_text('引数 2')
    capture('script-arguments')
    passed('function signature displays the active argument')

    area.fill('pm.')
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
    expect(suggestions).to_be_visible()
    area.press('ArrowDown')
    selected = suggestions.locator('[aria-selected=true]')
    assert selected.count() == 1
    assert area.get_attribute('aria-activedescendant') == selected.get_attribute('id')
    area.press('Escape')
    expect(suggestions).to_be_hidden()
    assert area.get_attribute('aria-activedescendant') is None
    passed('Ctrl+Space, arrow selection and Escape keep accessible active-option state')

    area.fill('console.l')
    suggestions.get_by_role('option', name='log', exact=True).click()
    expect(area).to_have_value('console.log')
    expect(area).to_be_focused()
    passed('pointer completion preserves textarea focus')

    area.fill('const token = "example";\n// レスポンスを検証\npm.response.')
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
        expect(suggestions).to_be_visible()
        box=suggestions.bounding_box()
        assert box and box['x']>=0 and box['x']+box['width']<=width+1, box
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        capture('script-completion-'+str(width))
    page.set_viewport_size({'width':1440,'height':1000})
    passed('syntax colors and completion popup remain visible without overflow at 320–1440px')
