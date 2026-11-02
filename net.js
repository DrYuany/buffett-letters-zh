/* net.js — 一个能走代理的 HTTP 取数封装

   为什么需要它：Node 的 fetch 不读 HTTPS_PROXY。本机（以及不少公司网络）
   访问外网必须经过本地代理，直接连会 ECONNRESET / UND_ERR_SOCKET，
   而 curl 能通——排查时很容易误判成「接口挂了」。

   策略：先直连（真实用户机器上通常没有代理，直连最快），
   失败且环境里有 HTTPS_PROXY 时，走 CONNECT 隧道重试一次。
   两条路都不通才把错误抛出去，让调用方如实说「没拿到」。
*/

const http = require('http');
const https = require('https');
const tls = require('tls');
const dns = require('dns');

/* 这台机器（以及不少国内网络）IPv6 走不通，而 Node 18+ 默认按解析结果原序、
   常常先试 IPv6，于是出现「curl 能开、Node 报 ECONNRESET」的怪现象。
   强制 IPv4 优先，整个进程生效。 */
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) { /* 老版本 Node 没有这个函数 */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function proxyOf() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
}

/* 直连。用 http/https 原生模块而不是 fetch，方便统一超时与编码处理。 */
function direct(url, opt) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('网址不合法：' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opt.method || 'GET',
      headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, opt.headers || {}),
      timeout: opt.timeout || 9000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    if (opt.body) req.write(opt.body);
    req.end();
  });
}

/* 代理：先 CONNECT 打通隧道，再在隧道上发原始请求。 */
function viaProxy(url, opt) {
  const proxy = proxyOf();
  return new Promise((resolve, reject) => {
    if (!proxy) return reject(new Error('没有代理可用'));
    let u, p;
    try { u = new URL(url); p = new URL(proxy); } catch (e) { return reject(new Error('地址不合法')); }
    const isHttps = u.protocol === 'https:';
    const port = u.port || (isHttps ? 443 : 80);
    const conn = http.request({
      host: p.hostname,
      port: p.port || 8080,
      method: 'CONNECT',
      path: u.hostname + ':' + port,
      headers: { Host: u.hostname + ':' + port },
      timeout: opt.timeout || 9000,
    });
    conn.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('代理拒绝：' + res.statusCode)); }
      const headers = Object.assign({ 'User-Agent': UA, Accept: '*/*', Host: u.hostname }, opt.headers || {});
      const send = sock => {
        const mod = isHttps ? https : http;
        const req = mod.request({
          host: u.hostname, path: u.pathname + u.search, method: opt.method || 'GET',
          headers, agent: false, createConnection: () => sock,
        }, r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (opt.body) req.write(opt.body);
        req.end();
      };
      if (isHttps) {
        const t = tls.connect({ socket, servername: u.hostname }, () => send(t));
        t.on('error', reject);
      } else send(socket);
    });
    conn.on('timeout', () => conn.destroy(new Error('代理连接超时')));
    conn.on('error', reject);
    conn.end();
  });
}

async function request(url, opt = {}) {
  try {
    return await direct(url, opt);
  } catch (e) {
    if (!proxyOf()) throw e;
    return await viaProxy(url, opt);
  }
}

/* 取文本，按页面声明或内容猜编码（东财有的接口是 GBK） */
async function fetchText(url, opt = {}) {
  const r = await request(url, opt);
  let text = r.buf.toString('utf8');
  const head = r.buf.slice(0, 2000).toString('latin1');
  const m = head.match(/charset=["']?\s*([\w-]+)/i);
  const enc = ((m && m[1]) || (opt.charset || '')).toLowerCase();
  if (enc && /gbk|gb2312|gb18030/.test(enc)) {
    try { text = new TextDecoder('gbk').decode(r.buf); } catch (e) { /* 没这个编码就保持 utf8 */ }
  } else if (!enc && /[\uFFFD]/.test(text.slice(0, 800))) {
    /* utf8 解出替换符，多半其实是 GBK */
    try { text = new TextDecoder('gbk').decode(r.buf); } catch (e) {}
  }
  return { status: r.status, headers: r.headers, text };
}

async function fetchJSON(url, opt = {}) {
  const r = await fetchText(url, opt);
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  return JSON.parse(r.text);
}

module.exports = { request, fetchText, fetchJSON, proxyOf, UA };
