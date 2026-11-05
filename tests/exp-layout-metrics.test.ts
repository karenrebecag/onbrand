import { describe, expect, test } from 'bun:test';
import { atomsOf, copiesIcons, skeletonOf, summarize, treeDistance } from '../src/exp/layout-metrics';

const split = (slug: string) => ({
  role: 'features',
  children: [{ layout: 'split', ratio: '1:1', children: [{ layout: 'stack', children: [{ text: 'title', value: 'A' }, { component: 'button', props: { icon: { $slot: { component: 'icon:lucide/Zap' } } } }] }, { component: slug }] }],
});
const grid = { role: 'features', children: [{ layout: 'stack', children: [{ text: 'title', value: 'B' }] }, { layout: 'grid', cols: 3, children: [{ component: 'card' }, { component: 'card' }, { component: 'card' }] }] };

describe('métricas del experimento de guías de layout', () => {
  test('átomos distintos: slugs de componente sin repetir y sin iconos', () => {
    expect(atomsOf(split('media-frame'))).toEqual(['button', 'media-frame']);
    expect(atomsOf(grid)).toEqual(['card']);
  });

  test('la distancia ignora el copy y crece con la estructura', () => {
    expect(treeDistance(split('media-frame'), { ...split('media-frame'), children: JSON.parse(JSON.stringify(split('media-frame')).replace('"A"', '"Otro copy"')).children })).toBe(0);
    expect(treeDistance(split('media-frame'), split('sparkline'))).toBeGreaterThan(0);
    expect(treeDistance(split('media-frame'), grid)).toBeGreaterThan(treeDistance(split('media-frame'), split('sparkline')));
    expect(skeletonOf(grid)[3]).toBe('1:grid[cols=3]');
  });

  test('separación = distancia entre negocios / distancia dentro del negocio', () => {
    const runs = [
      { business: 'a', cond: 'guide', rep: 1, section: split('x'), renderOk: true },
      { business: 'a', cond: 'guide', rep: 2, section: split('x'), renderOk: true },
      { business: 'b', cond: 'guide', rep: 1, section: grid, renderOk: false },
      { business: 'b', cond: 'guide', rep: 2, section: grid },
    ];
    const [con] = summarize(runs);
    expect(con.within.mean).toBe(0);
    expect(con.between.mean).toBeGreaterThan(0);
    expect(con.separation).toBe(Infinity);
    expect(con.renderOk).toEqual({ ok: 2, measured: 3 });
  });

  test('fidelidad a la guía: cuenta las corridas a distancia ~0 del árbol inyectado', () => {
    const runs = [
      { business: 'a', cond: 'guide1', rep: 1, section: split('x'), injected: split('x') },
      { business: 'a', cond: 'guide1', rep: 2, section: grid, injected: split('x') },
      { business: 'b', cond: 'noguide', rep: 1, section: grid },
    ];
    const [g1, ng] = summarize(runs);
    expect(g1.fidelity.emits).toBe(1);
    expect(g1.fidelity.measured).toBe(2);
    expect(ng.fidelity.measured).toBe(0);
  });

  test('copia literal de iconos: true solo si todos los iconos emitidos venían en la plantilla', () => {
    const withIcons = (...names: string[]) => ({ role: 'features', children: [{ layout: 'grid', cols: 2, children: names.map((n) => ({ component: 'card', props: { media: { $slot: { component: `icon:lucide/${n}` } }, title: 't' } })) }] });
    const injected = withIcons('Zap', 'Clock');
    expect(copiesIcons(withIcons('Zap', 'Clock'), injected)).toBe(true);
    expect(copiesIcons(withIcons('Clock', 'Zap', 'Clock'), injected)).toBe(true);
    expect(copiesIcons(withIcons('Zap', 'Users'), injected)).toBe(false);
    expect(copiesIcons(grid, injected)).toBe(false);
    const [g1] = summarize([{ business: 'a', cond: 'guide1', rep: 1, section: withIcons('Zap'), injected }, { business: 'a', cond: 'guide1', rep: 2, section: withIcons('Users'), injected }]);
    expect(g1.iconCopy).toEqual({ copied: 1, measured: 2 });
  });
});
