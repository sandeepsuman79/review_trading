import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSessionReviewService} from '../server/sessionReview.js'
const input={version:1,instrument:'Nifty 50',date:'2026-10-19',suggestions:[],confirmed:0}
test('Gemini review has its own schema, deduplicates calls, and rejects malformed reports',async()=>{
 let calls=0
 const review=createSessionReviewService({gemini:{generate:async body=>{calls++;assert.match(body.systemInstruction.parts[0].text,/untrusted/);return{summary:'Collect more verified history.'}}}})
 const [a,b]=await Promise.all([review(input),review(input)])
 assert.deepEqual(a,b);assert.equal(calls,1);await review(input);assert.equal(calls,1)
 await assert.rejects(review({...input,instrument:'invalid'}),e=>e.status===400)
})
test('provider failures remain retryable and malformed suggestions are never cached',async()=>{
 let calls=0
 const review=createSessionReviewService({gemini:{generate:async()=>{if(++calls===1)throw new Error('quota');return{summary:'Review missing quote coverage.'}}}})
 await assert.rejects(review(input),/quota/);assert.equal((await review(input)).summary,'Review missing quote coverage.')
 const invalid=createSessionReviewService({gemini:{generate:async()=>({bias:'CALL'})}})
 await assert.rejects(invalid(input),/invalid review/)
})
