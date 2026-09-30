// Shared horizontal collision and grid navigation for players and patrols.
export function isBlocked(x, z, solids, radius = 0.4) {
  return solids.some(s => x + radius > s.minX && x - radius < s.maxX && z + radius > s.minZ && z - radius < s.maxZ);
}

export function moveWithCollision(position, dx, dz, solids, radius = 0.4) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.25));
  for (let i = 0; i < steps; i++) {
    if (!isBlocked(position.x + dx / steps, position.z, solids, radius)) position.x += dx / steps;
    if (!isBlocked(position.x, position.z + dz / steps, solids, radius)) position.z += dz / steps;
  }
  return position;
}

export function createNavigator(solids, cell = 2, limit = 48) {
  const size = Math.floor(limit * 2 / cell) + 1;
  const walkable = new Uint8Array(size * size);
  const point = id => ({ x: (id % size) * cell - limit, z: Math.floor(id / size) * cell - limit });
  const idAt = p => Math.max(0, Math.min(size - 1, Math.round((p.z + limit) / cell))) * size + Math.max(0, Math.min(size - 1, Math.round((p.x + limit) / cell)));
  for (let id = 0; id < walkable.length; id++) { const p = point(id); walkable[id] = isBlocked(p.x, p.z, solids, .55) ? 0 : 1; }
  // Precompute valid edges, since a thin post can fall between free grid cells.
  const directions = [[1,0],[-1,0],[0,1],[0,-1]];
  const connections = new Uint8Array(size * size);
  for (let id = 0; id < walkable.length; id++) {
    if (!walkable[id]) continue;
    const x = id % size, z = Math.floor(id / size), p = point(id);
    directions.forEach(([dx,dz], bit) => {
      const nx=x+dx,nz=z+dz;
      if(nx<0||nz<0||nx>=size||nz>=size||!walkable[nz*size+nx])return;
      const q=point(nz*size+nx);
      const blocked=solids.some(s=>Math.max(p.x,q.x)+.55>s.minX&&Math.min(p.x,q.x)-.55<s.maxX&&Math.max(p.z,q.z)+.55>s.minZ&&Math.min(p.z,q.z)-.55<s.maxZ);
      if(!blocked)connections[id]|=1<<bit;
    });
  }
  function nearest(p) {
    const id = idAt(p);
    if (walkable[id]) return id;
    let best = -1, distance = Infinity;
    for (let i = 0; i < walkable.length; i++) {
      if (!walkable[i]) continue;
      const q = point(i), d = (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
      if (d < distance) { distance = d; best = i; }
    }
    return best;
  }
  return {
    path(start, end) {
      const a = nearest(start), b = nearest(end);
      if (a < 0 || b < 0) return [];
      const queue = [a], parents = new Int32Array(size * size).fill(-1);
      parents[a] = a;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const id = queue[cursor];
        if (id === b) break;
        const x = id % size, z = Math.floor(id / size);
        for (let bit = 0; bit < directions.length; bit++) {
          if (!(connections[id] & (1 << bit))) continue;
          const [dx, dz] = directions[bit];
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
          const n = nz * size + nx;
          if (!walkable[n] || parents[n] !== -1) continue;
          parents[n] = id; queue.push(n);
        }
      }
      if (parents[b] < 0) return [];
      const result = [];
      for (let n = b; n !== a; n = parents[n]) result.push(point(n));
      result.reverse();
      return result;
    },
    reachable(start, end) { const a = nearest(start), b = nearest(end); return a >= 0 && b >= 0 && (a === b || this.path(start, end).length > 0); },
  };
}
