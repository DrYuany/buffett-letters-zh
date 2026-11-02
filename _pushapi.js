/* 代理把 git push 挡在外面时（CONNECT tunnel failed 502），走 GitHub API 直写远端。
 *
 *   node _pushapi.js             推本地领先的提交
 *   node _pushapi.js --dry       只看要推什么，不真推
 *
 * 原理：git data API —— 为每个本地提交算出「改了哪些文件」，用 base_tree + 这些文件的
 * 内容创建新 tree，再建 commit，最后把分支 ref 指过去。不是 force push 那种覆盖：
 * parents 指向远端当前 head，所以远端已有的历史会完整保留。
 */
const { spawnSync } = require('child_process');
const REPO = 'DrYuany/buffett-letters-zh';
const BRANCH = 'main';
const DRY = process.argv.indexOf('--dry') >= 0;

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + (r.stderr || '').slice(0, 200));
  return r.stdout;
}
function api(method, path, body) {
  /* 路径不要前导斜杠：Git Bash（MSYS）会把 /repos/... 当成文件路径改写掉 */
  const args = ['api', '-X', method, String(path).replace(/^\//, '')];
  if (body !== undefined) args.push('--input', '-');
  const r = spawnSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8', maxBuffer: 1 << 28
  });
  if (r.error) throw new Error('gh 调不起来：' + r.error.message);
  if (r.status !== 0) throw new Error('gh api ' + method + ' ' + path + ' 失败：' + (r.stderr || '').slice(0, 300));
  return r.stdout ? JSON.parse(r.stdout) : null;
}

(async () => {
  /* 基准必须用远端真实 head，不能用本地的 origin/main ——
     上次走 API 推过之后本地的 remote-tracking ref 还停在旧位置，
     拿它当 parents 会被远端以「not a fast forward」拒掉。 */
  const remote = api('GET', 'repos/' + REPO + '/git/refs/heads/' + BRANCH).object.sha;
  /* 上一轮 API 推上去的 commit 在本地并不存在（是远端生成的），这时 rev-list 会报
     Invalid revision range。给 --commits 显式列出要推的提交即可。 */
  const given = (() => { const i = process.argv.indexOf('--commits'); return i >= 0 ? process.argv[i + 1] : ''; })();
  const ahead = given ? given.split(',').filter(Boolean)
    : git(['rev-list', '--reverse', remote + '..' + BRANCH]).trim().split('\n').filter(Boolean);
  if (!ahead.length) { console.log('没有领先的提交，不用推。'); return; }
  console.log('远端 ' + remote.slice(0, 7) + ' · 本地领先 ' + ahead.length + ' 个提交：');
  ahead.forEach(c => console.log('  ' + c.slice(0, 7) + '  ' + git(['log', '-1', '--format=%s', c]).trim()));
  if (DRY) return;

  let head = remote;
  for (const c of ahead) {
    const msg = git(['log', '-1', '--format=%B', c]);
    const changed = git(['diff', '--name-status', c + '^', c]).trim().split('\n').filter(Boolean);
    const tree = [];
    for (const line of changed) {
      const st = line[0], p = line.slice(1).trim();
      if (st === 'D') { tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
      const mode = git(['ls-tree', c, '--', p]).trim().split(/\s+/)[0] || '100644';
      const content = git(['show', c + ':' + p]);
      tree.push({ path: p, mode: mode, type: 'blob', content: content });
    }
    const t = api('POST', 'repos/' + REPO + '/git/trees', { base_tree: head, tree: tree });
    const cm = api('POST', 'repos/' + REPO + '/git/commits', {
      message: msg, tree: t.sha, parents: [head]
    });
    api('PATCH', 'repos/' + REPO + '/git/refs/heads/' + BRANCH, { sha: cm.sha });
    head = cm.sha;
    console.log('  → ' + c.slice(0, 7) + ' 推上去成 ' + cm.sha.slice(0, 7) +
      '（改了 ' + changed.length + ' 个文件）');
  }
  console.log('完成。远端 ' + BRANCH + ' 现在指向 ' + head.slice(0, 7));
  console.log('（本地的 origin/' + BRANCH + ' 还没更新，等代理通了跑 git fetch 对齐；内容已一致。）');
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
