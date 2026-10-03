import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
test('portable manifest matches published Agent Plugins schema shape and package identity',async()=>{
  const p=JSON.parse(await fs.readFile(path.join(root,'plugin.json'),'utf8'));
  assert.equal(p.$schema,'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  const allowed=['$schema','name','version','description','author','homepage','repository','license','keywords','extensions'];
  assert.ok(Object.keys(p).every(k=>allowed.includes(k)));
  assert.match(p.name,/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);assert.ok(p.name.length<=64);
  assert.match(p.version,/^\d+\.\d+\.\d+$/);assert.equal(path.basename(path.resolve(root)),p.name);
  const ui=p.extensions['com.openai'].interface;
  assert.ok([...ui.shortDescription].length<=30);assert.ok(ui.defaultPrompt.length<=3);
  for(const asset of [ui.logo,ui.composerIcon,p.extensions['com.openai'].onboardingSkill]) {
    assert.ok(!asset.includes('..'));assert.ok((await fs.stat(path.join(root,asset))).isFile());
  }
  const compat=JSON.parse(await fs.readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
  assert.equal(compat.name,p.name);assert.equal(compat.version,p.version);assert.deepEqual(compat.interface,ui);
});
test('portable stdio config points to real entrypoint without machine specific paths or credentials',async()=>{
  const m=JSON.parse(await fs.readFile(path.join(root,'mcp.json'),'utf8'));
  assert.equal(m.$schema,'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(m).sort(),['$schema','mcpServers']);
  assert.equal(Object.keys(m.mcpServers).length,1);
  const s=m.mcpServers.siyuan;
  assert.equal(s.type,'stdio');assert.equal(s.command,'node');assert.equal(s.cwd,'${PLUGIN_ROOT}');
  assert.equal(s.args.length,1);assert.ok((await fs.stat(s.args[0].replace('${PLUGIN_ROOT}',root))).isFile());
  assert.ok(Object.keys(s).every(k=>['type','command','args','env','cwd'].includes(k)));
  assert.equal(s.env,undefined);
});
test('all packaged skills have matching names and descriptive YAML frontmatter',async()=>{
  for(const name of await fs.readdir(path.join(root,'skills'))) {
    const text=await fs.readFile(path.join(root,'skills',name,'SKILL.md'),'utf8');
    assert.ok(text.startsWith('---\n'));assert.ok(text.includes(`name: ${name}\n`));assert.match(text,/description: .+\n/);
  }
});
