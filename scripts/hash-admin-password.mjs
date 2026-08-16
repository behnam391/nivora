import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/auth.js';

const password=readFileSync(0,'utf8').replace(/[\r\n]+$/,'');
const result=hashPassword(password);
process.stdout.write(`${result.salt}:${result.hash}`);
