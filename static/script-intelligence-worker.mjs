/** One persistent language-service process for editor requests, isolated from UI work. */
import {createScriptIntelligence} from './script-intelligence.mjs';

const service = createScriptIntelligence();
self.addEventListener('message', ({data}) => {
  if (!data || !Number.isSafeInteger(data.id)) return;
  try {
    const options = data.options || {};
    let result;
    if (data.method === 'analyze') result = service.analyze(data.source, data.position, options);
    else if (data.method === 'details') result = service.details(data.source, data.position, data.name, options);
    else throw new Error('利用できないコード解析操作です。');
    self.postMessage({id:data.id, result});
  } catch (error) {
    self.postMessage({id:data.id, error:{message:String(error?.message || error)}});
  }
});
