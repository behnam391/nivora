import { createServer } from 'node:http';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { createThreeXuiProvisioner } from './providers/three-x-ui.js';
import { loadNeuralMeshManifestServiceFromEnv } from './neuralmesh-manifest.js';

const port = Number(process.env.PORT || 8787);
if(process.env.NODE_ENV==='production'&&(!process.env.ADMIN_TOKEN||process.env.ADMIN_TOKEN.length<32||process.env.ADMIN_TOKEN==='dev-only-change-me'))throw new Error('ADMIN_TOKEN must be a unique random value of at least 32 characters in production');
const db = openDatabase();
const provisioner = process.env.PANEL_API_TOKEN ? createThreeXuiProvisioner() : null;
const neuralMeshManifest = loadNeuralMeshManifestServiceFromEnv();
const app = createApp(db, { provisioner, neuralMeshManifest });
const server = createServer(app);
const sweepMs=Math.max(15_000,(Number(process.env.AUTO_REVIEW_SWEEP_SECONDS)||60)*1000);setInterval(()=>Promise.resolve(app.sweep()).catch(e=>console.error(JSON.stringify({time:new Date().toISOString(),event:'auto_review_sweep_error',message:String(e?.message||e)}))),sweepMs).unref();
server.requestTimeout=30_000;server.headersTimeout=15_000;server.keepAliveTimeout=5_000;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({time:new Date().toISOString(),event:'server_started',address:`http://127.0.0.1:${port}`})));
let stopping=false;const shutdown=signal=>{if(stopping)return;stopping=true;console.log(JSON.stringify({time:new Date().toISOString(),event:'shutdown',signal}));server.close(()=>{try{db.close()}finally{process.exit(0)}});setTimeout(()=>process.exit(1),10_000).unref()};process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));process.on('uncaughtException',e=>{console.error(JSON.stringify({time:new Date().toISOString(),event:'uncaught_exception',message:e.message,stack:e.stack}));shutdown('uncaughtException')});process.on('unhandledRejection',e=>console.error(JSON.stringify({time:new Date().toISOString(),event:'unhandled_rejection',message:String(e?.message||e)})));
