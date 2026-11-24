import { parseVerify } from '../src/jobs/verify-ack.js';

const samples = [
  '{"verdict":"confirmed","reason":"ok","evidence_used":["live"]}',
  'Here:\n```json\n{"verdict":"failed","reason":"still 404","evidence_used":["http"]}\n```',
  '{ "verdict": "confirmed", "reason": "pass", "evidence_used": [] }',
];

for (const s of samples) {
  console.log(parseVerify(s));
}
console.log('parseVerify smoke ok');
