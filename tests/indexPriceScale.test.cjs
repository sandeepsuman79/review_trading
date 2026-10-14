const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), ts=require('typescript')
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename)
const {indexPriceDomain,indexPriceLevels,priceScalePosition}=require('../src/analysis/indexPriceScale.ts')
test('index scale uses exact 50/100 point multiples without padding the candle domain',()=>{
  assert.deepEqual(indexPriceLevels(22422.5,22609.7,'Nifty 50'),[22600,22550,22500,22450])
  for(const index of ['Sensex','Bank Nifty']) assert.deepEqual(indexPriceLevels(72555.45,73198.95,index),[73100,73000,72900,72800,72700,72600])
  assert.deepEqual(indexPriceLevels(22480,22490,'Nifty 50'),[])
  assert.deepEqual(indexPriceLevels(NaN,22490,'Nifty 50'),[])
  assert.deepEqual(indexPriceLevels(0,100000,'Nifty 50'),[])
})
test('price rows align vertically with their underlying strike, not with the premium amount',()=>{
  assert.equal(priceScalePosition(73100,72600,73200,300),50)
  assert.equal(priceScalePosition(72600,72600,73200,300),300)
})

test('a tight no-strike domain exposes one actual level, and normal domains stay unchanged',()=>{
  assert.deepEqual(indexPriceDomain(72555.45,73198.95,'Sensex'),{min:72555.45,max:73198.95})
  const domain=indexPriceDomain(48080,48090,'Bank Nifty')
  assert.deepEqual(indexPriceLevels(domain.min,domain.max,'Bank Nifty'),[48100])
  assert(domain.min<=48080 && domain.max>=48090)
})
