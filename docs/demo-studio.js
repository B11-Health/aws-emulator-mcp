'use strict';
// This is an educational interface, not a network-connected AWS emulator.
// Every scenario links to real source or recorded CI evidence.
const missions = [
 {tag:'OFFLINE · VERIFIED LOCAL OUTPUT',title:'Prove your install works',story:'Run the smallest test first. The generator checks seven actual files in a temporary directory, then cleans up.',aLabel:'Artifacts checked',a:'7 / 7',bLabel:'Cloud API calls',b:'0',command:'node bin/aws-emulator-mcp.mjs try --json',learn:'A deterministic S3 + DynamoDB + SQS architecture bundle was generated and checked. Its 14-step contract is a plan, not an executed test.',limit:'Emulator APIs, AWS IAM and deployments.',proof:'evidence/showcase-offline-trial-beta15.json'},
 {tag:'DOCKER · SIGNED EMULATOR API TEST',title:'Catch a duplicate order event',story:'The sample order service handles the same order twice. First, a naive implementation sends two fulfillment events. A conditional DynamoDB write fixes it.',aLabel:'Before: SQS events',a:'2',bLabel:'After: SQS events',b:'1',command:'node bin/aws-emulator-mcp.mjs app-debug compare --json',learn:'The reviewed app goes from two accepted submissions and two SQS messages to one accepted submission and one message. Every run checks scoped resource cleanup.',limit:'Your entire application is not automatically tested; this is a packaged reference scenario.',proof:'https://github.com/B11-Health/aws-emulator-mcp/blob/v0.4.0-beta.15/docs/APP_DEBUGGING.md'},
 {tag:'DOCKER · SYNTHETIC SDK-BOUNDARY TIMEOUT',title:'Recover from a partial write',story:'DynamoDB stores an order, then the first S3 receipt upload is rejected locally. A premature queued flag loses the work; a pending-state retry repairs it.',aLabel:'Fragile: SQS events',a:'0',bLabel:'Recovered: SQS events',b:'1',command:'node bin/aws-emulator-mcp.mjs failure-lab partial-compare --json',learn:'After a synthetic S3 pre-call timeout, the recovered handler recreates the receipt and publishes one fulfillment event. The test inspects actual emulator state.',limit:'A real process crash, cloud outage, concurrency race or transactional-outbox guarantee.',proof:'https://github.com/B11-Health/aws-emulator-mcp/blob/v0.4.0-beta.15/docs/FAILURE_LAB.md'},
 {tag:'DOCKER · EXPLICIT TRUSTED LOCAL FILES',title:'Test your own before/after fix',story:'Point the CLI at two Python order handlers you own. Each gets a separate local lab; the comparison reports hashes, assertions and cleanup results.',aLabel:'Selected handlers',a:'2',bLabel:'Comparison',b:'Before / after',command:'node bin/aws-emulator-mcp.mjs app-compare examples/byo-order-handler/buggy.py examples/byo-order-handler/fixed.py --markdown',learn:'A reproduced bug and passing correction are required for a passing comparison; the report can be reviewed in a pull request.',limit:'Running untrusted third-party code safely or supporting arbitrary app architectures. Do not run untrusted PR code.',proof:'https://github.com/B11-Health/aws-emulator-mcp/blob/v0.4.0-beta.15/docs/BYO_HANDLER.md'},
 {tag:'NO DOCKER · REVIEWED BLUEPRINT ONLY',title:'Catch a risky infrastructure change',story:'Compare two checked-in blueprints. Changing a DynamoDB partition key is flagged for human review and generates architecture diff artifacts.',aLabel:'Example key change',a:'orderId',bLabel:'New key',b:'orderRef',command:'node bin/aws-emulator-mcp.mjs architecture review examples/architecture/review/before.json examples/architecture/review/after.json --json',learn:'A conservative source-level review helps a developer spot a potentially breaking table-key change before merge.',limit:'An AWS CloudFormation change set, real AWS deployment effects, or IAM validation.',proof:'https://github.com/B11-Health/aws-emulator-mcp/blob/v0.4.0-beta.15/docs/ARCHITECTURE_REVIEW.md'},
 {tag:'NO DOCKER FOR CONFIG · LOCAL STDIO',title:'Connect your coding assistant',story:'Generate a supported local MCP configuration for your editor, then ask the agent to execute one reviewed experiment.',aLabel:'Curated MCP tools',a:'38',bLabel:'Transport',b:'stdio',command:'node bin/aws-emulator-mcp.mjs config vscode',learn:'Copy the generated local executable configuration into a supported MCP client. Then try: “Run the order-intake before/after scenario and summarize assertions.”',limit:'Connecting automatically to this website or using emulator-backed tools without local Docker.',proof:'https://github.com/B11-Health/aws-emulator-mcp/blob/v0.4.0-beta.15/docs/ONBOARDING.md'}
];
function el(id){return document.getElementById(id)}
function showMission(index, moveFocus){
 const m=missions[index]; if(!m)return;
 document.querySelectorAll('[data-mission]').forEach(button=>{
  const active=Number(button.dataset.mission)===index;
  button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
  if(active && moveFocus)button.focus();
 });
 el('mission-panel').setAttribute('aria-labelledby','tab-'+index);
 for(const [id,value] of Object.entries({
  'mission-tag':m.tag,'mission-title':m.title,'mission-story':m.story,
  'metric-a-label':m.aLabel,'metric-a':m.a,'metric-b-label':m.bLabel,'metric-b':m.b,
  'mission-learn':m.learn,'mission-limit':m.limit
 }))el(id).textContent=value;
 el('mission-command').querySelector('code').textContent=m.command;
 el('mission-proof').href=m.proof;
 const clips=[
  ['beta15-quickstart-demo.mp4','12'],['beta15-reliability-demo.mp4','21'],
  ['beta15-reliability-demo.mp4','21'],['beta15-source-review-demo.mp4','22'],
  ['beta15-source-review-demo.mp4','22'],['beta15-connect-agent-demo.mp4','9']
 ];
 el('mission-video').href='assets/demos/'+clips[index][0];
 el('mission-video').textContent='▶ Watch this part ('+clips[index][1]+' seconds)';
}
document.querySelectorAll('[data-mission]').forEach(button=>{
 button.addEventListener('click',()=>showMission(Number(button.dataset.mission),false));
 button.addEventListener('keydown',event=>{
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const i=Number(button.dataset.mission),next=event.key==='Home'?0:event.key==='End'?missions.length-1:((i+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1))+missions.length)%missions.length;
  showMission(next,true);
 });
});
async function copyText(text){
 if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(text);return}
 const field=document.createElement('textarea');field.value=text;field.setAttribute('aria-hidden','true');field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);field.select();
 if(!document.execCommand('copy'))throw new Error('Clipboard unavailable');
 field.remove();
}
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{
 const original=button.textContent;const element=el(button.dataset.copy);
 try{await copyText(element.textContent.trim());button.textContent='Copied ✓'}
 catch{button.textContent='Select text above to copy'}
 setTimeout(()=>button.textContent=original,2400);
}));
showMission(0,false);
