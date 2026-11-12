// Independent official TypeScript MCP client SDK v2 interoperability check.
// Dev-only: npm install --no-audit --ignore-scripts @modelcontextprotocol/client@2.4.0
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../../src/aws_emulator_mcp/server.py', import.meta.url));
const command = process.env.CODEGYM_PYTHON || 'python3';
const results=[];
for (const [mode, options] of [
  ['legacy', {}],
  ['auto', {versionNegotiation:{mode:'auto',probe:{timeoutMs:4000}}}]
]) {
  const client=new Client({name:'codegym-independent-ts-interop',version:'1.0.0'},options);
  const transport=new StdioClientTransport({command,args:[server]});
  try {
    await client.connect(transport);
    const listed=await client.listTools();
    if(listed.tools.length!==27)throw new Error(mode+' discovered '+listed.tools.length+' instead of 27 tools');
    const response=await client.callTool({name:'emulator_status',arguments:{}});
    if(response.isError)throw new Error(mode+' tool failed: '+JSON.stringify(response));
    const status=JSON.parse(response.content.find(c=>c.type==='text').text);
    if(!status.endpoint.startsWith('https://127.0.0.1:'))throw new Error(mode+' returned non-local endpoint');
    results.push({mode,era:client.getProtocolEra(),tools:listed.tools.length,localEndpoint:true});
  } finally {
    await client.close();
  }
}
if(results[0].era!=='legacy'||results[1].era!=='modern')throw new Error('Wrong protocol-era negotiation');
console.log(JSON.stringify({client:'official TypeScript MCP SDK v2.4.0',passed:true,results},null,2));
