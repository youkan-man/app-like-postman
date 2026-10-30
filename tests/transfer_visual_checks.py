"""Layout assertions and cropped evidence alongside the real HTTP transfer suite.

This observes the live UI only. It neither supplies progress values nor changes
network responses. Dark/reduced-motion captures change presentation only.
"""
import json


def check_transfer_layout(page, out, name):
    root = page.locator('#transferProgress')
    data = root.evaluate('''el => {
      const rect = node => {const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const field = cls => {const node=el.querySelector(cls);return {rect:rect(node),text:node.textContent,visibility:getComputedStyle(node).visibility};};
      const parent=el.parentElement, bar=el.querySelector('progress');
      return {phase:el.dataset.phase,root:rect(el),parent:rect(parent),clientWidth:parent.clientWidth,
        label:field('.transfer-progress-label'),percent:field('.transfer-progress-percent'),amount:field('.transfer-progress-detail'),route:field('.transfer-progress-route'),
        track:rect(el.querySelector('.transfer-progress-track')),determinate:bar.hasAttribute('value'),value:bar.value,max:bar.max,
        viewport:{width:innerWidth,height:innerHeight},pageOverflow:document.documentElement.scrollWidth>innerWidth};
    }''')
    box = data['root']
    assert abs(box['x'] - data['parent']['x']) < 1, data
    assert abs(box['width'] - data['clientWidth']) < 1, data
    assert not data['pageOverflow'], data
    for key in ['label','percent','amount','route']:
        field = data[key]
        if not field['text'] or field['visibility'] == 'hidden':
            continue
        rect = field['rect']
        assert rect['x'] >= box['x'] and rect['right'] <= box['right'] + 1, (key, data)
        assert rect['y'] >= box['y'] and rect['bottom'] <= box['bottom'] + 1, (key, data)
    if data['determinate']:
        assert data['percent']['text'].endswith('%') and '%' not in data['amount']['text'], data
        assert data['label']['rect']['right'] + 4 <= data['percent']['rect']['x'], data
        assert 0 <= data['value'] <= data['max'], data
    else:
        assert not data['percent']['text'] and not data['amount']['text'], data
    a, b = data['amount']['rect'], data['route']['rect']
    if data['amount']['text'] and abs(a['y']-b['y']) < 1:
        assert a['right'] + 4 <= b['x'], data
    assert 5 <= data['track']['height'] <= 8, data
    assert box['height'] <= 96, data
    # Capture the component in its real application context, not a generated mock.
    root.screenshot(path=str(out / (name + '-strip.png')))
    if name == 'response-wait-desktop':
        theme = page.locator('html').get_attribute('data-theme')
        try:
            page.locator('html').evaluate("el => el.dataset.theme='dark'")
            root.screenshot(path=str(out / 'response-wait-dark-strip.png'))
            page.emulate_media(reduced_motion='reduce')
            assert root.locator('.transfer-progress-pulse').evaluate("el => getComputedStyle(el).animationName") == 'none'
            root.screenshot(path=str(out / 'response-wait-reduced-motion-strip.png'))
        finally:
            page.locator('html').evaluate("(el,theme)=>{if(theme===null)el.removeAttribute('data-theme');else el.dataset.theme=theme;}", theme)
            page.emulate_media(reduced_motion='no-preference')
    path = out / 'presentation-checks.json'
    report = json.loads(path.read_text()) if path.exists() else {'mode':'live HTTP progress UI geometry','checks':[]}
    if name == 'response-wait-desktop':
        prior = next(row for row in report['checks'] if row['name'] == 'upload-desktop')
        assert abs(prior['root']['height'] - box['height']) < .5, (prior, data)
    report['checks'].append({'name':name, **data})
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print('PASS live progress layout: '+name, flush=True)
