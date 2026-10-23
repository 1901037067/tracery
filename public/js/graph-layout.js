/** Barnes–Hut 斥力：小图精确计算，大图用四叉树聚合远处节点。 */
export function repel(nodes) {
  const force = (n, x, y, mass) => {
    let dx = n.x - x, dy = n.y - y, d2 = dx * dx + dy * dy;
    if (d2 > 400000) return;
    if (d2 < 1) { dx = .5; dy = .3; d2 = 1; }
    const f = 900 * mass / (d2 * Math.sqrt(d2));
    n.vx += dx * f; n.vy += dy * f;
  };
  if (nodes.length <= 128) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], vx = a.vx, vy = a.vy;
      force(a, b.x, b.y, 1); b.vx -= a.vx - vx; b.vy -= a.vy - vy;
    }
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const cell = (x, y, size) => ({ x, y, size, mass: 0, sx: 0, sy: 0, points: [], children: null });
  const root = cell(minX, minY, Math.max(1, maxX - minX, maxY - minY) + 1);
  const add = (q, n, depth) => {
    q.mass++; q.sx += n.x; q.sy += n.y;
    if (!q.children && (!q.points.length || depth >= 18)) { q.points.push(n); return; }
    const sub = p => { const h = q.size / 2; return (p.x >= q.x + h ? 1 : 0) + (p.y >= q.y + h ? 2 : 0); };
    if (!q.children) {
      const h = q.size / 2;
      q.children = [cell(q.x, q.y, h), cell(q.x + h, q.y, h), cell(q.x, q.y + h, h), cell(q.x + h, q.y + h, h)];
      for (const p of q.points) add(q.children[sub(p)], p, depth + 1);
      q.points = [];
    }
    add(q.children[sub(n)], n, depth + 1);
  };
  for (const n of nodes) add(root, n, 0);
  const visit = (q, n) => {
    if (!q.mass) return;
    // 整个单元格都在有效距离外时跳过，避免远处聚合误伤近邻。
    const nearX = Math.max(q.x, Math.min(n.x, q.x + q.size)), nearY = Math.max(q.y, Math.min(n.y, q.y + q.size));
    if ((n.x - nearX) ** 2 + (n.y - nearY) ** 2 > 400000) return;
    if (!q.children) { for (const p of q.points) if (p !== n) force(n, p.x, p.y, 1); return; }
    const x = q.sx / q.mass, y = q.sy / q.mass, d2 = (n.x - x) ** 2 + (n.y - y) ** 2;
    const contains = n.x >= q.x && n.x <= q.x + q.size && n.y >= q.y && n.y <= q.y + q.size;
    if (!contains && q.size ** 2 < .64 * d2 && d2 < 300000) force(n, x, y, q.mass);
    else for (const child of q.children) visit(child, n);
  };
  for (const n of nodes) visit(root, n);
}
