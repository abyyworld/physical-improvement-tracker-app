// To-dos: checked field by field, merged per to-do (the later change wins, deletions too), and
// sorted for a day.

import { describe, expect, it } from 'vitest';
import { cleanTodo, cleanTodos, forDay, mergeTodos, MAX_TODOS, type Todos } from './todos';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const t = (id: string, extra: object = {}) => ({ id, title: `Do ${id}`, created: NOW - DAY, at: NOW - DAY, ...extra });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('a to-do', () => {
  it('keeps only what it may have', () => {
    expect(cleanTodo({ ...t('a'), title: '  Call\nmum  ', day: '2026-11-14', time: '09:30', from: 'Claude', extra: 'x' })).toEqual({ id: 'a', title: 'Call mum', day: '2026-11-14', time: '09:30', from: 'Claude', created: NOW - DAY, at: NOW - DAY });
    expect(cleanTodo({ ...t('a'), time: '09:30' })).not.toHaveProperty('time'); // a time only with a day
    expect(cleanTodo({ ...t('a'), day: '2026-13-01' })).not.toHaveProperty('day');
    expect(cleanTodo({ ...t('a'), title: '   ' })).toBeNull();
    expect(cleanTodo({ ...t('a b') })).toBeNull();
    expect(cleanTodo({ ...t('a'), at: 'soon' })).toBeNull();
    expect(cleanTodo({ ...t('a'), title: 'x'.repeat(500) })!.title).toHaveLength(200);
    expect(cleanTodo({ id: 'a', at: NOW, gone: true, title: 'secret' })).toEqual({ id: 'a', title: '', created: NOW, at: NOW, gone: true });
  });

  it('lets old deletions and long-done to-dos go, and keeps at most the newest 1000', () => {
    const raw = { old: { id: 'old', at: NOW - 200 * DAY, gone: true }, done: t('done', { done: NOW - 500 * DAY }), keep: t('keep'), wrong: t('other') };
    expect(Object.keys(cleanTodos(raw, NOW))).toEqual(['keep']);
    const many = Object.fromEntries(Array.from({ length: MAX_TODOS + 5 }, (_, i) => [`t${i}`, t(`t${i}`, { at: NOW - i })]));
    const kept = cleanTodos(many, NOW);
    expect(Object.keys(kept)).toHaveLength(MAX_TODOS);
    expect(kept).not.toHaveProperty(`t${MAX_TODOS + 4}`);
    // Deletions aren't pushed out by many to-dos.
    const withGone = cleanTodos({ ...many, g: { id: 'g', at: NOW - 10 * DAY, gone: true } }, NOW);
    expect(withGone.g).toMatchObject({ gone: true });
  });

  it('keeps the same order whatever order they came in, so the same to-dos save the same', () => {
    const one = cleanTodos({ b: t('b', { at: NOW - 1 }), a: t('a', { at: NOW - 2 }), c: t('c', { at: NOW }) }, NOW);
    const two = cleanTodos({ c: t('c', { at: NOW }), a: t('a', { at: NOW - 2 }), b: t('b', { at: NOW - 1 }) }, NOW);
    expect(Object.keys(one)).toEqual(['a', 'b', 'c']);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

describe('two copies', () => {
  it('take each to-do from the copy that changed it last, deletions too', () => {
    const a: Todos = cleanTodos({ x: t('x', { at: NOW - 10, done: NOW - 10 }), y: t('y', { at: NOW - 5 }), z: t('z') }, NOW);
    const b: Todos = cleanTodos({ x: t('x', { at: NOW - 20 }), y: { id: 'y', at: NOW - 1, gone: true }, w: t('w') }, NOW);
    const m = mergeTodos(a, b, NOW);
    expect(m.x.done).toBe(NOW - 10);
    expect(m.y.gone).toBe(true);
    expect(Object.keys(m).sort()).toEqual(['w', 'x', 'y', 'z']);
    expect(mergeTodos(b, a, NOW)).toEqual(m);
  });
});

describe('a day', () => {
  it("has what's left (overdue and undated too), what got done that day, and what's coming", () => {
    const todos = cleanTodos(
      {
        late: t('late', { day: '2026-11-10' }),
        today: t('today', { day: '2026-11-13', time: '08:00' }),
        any: t('any'),
        soon: t('soon', { day: '2026-11-20' }),
        did: t('did', { done: NOW }),
        before: t('before', { done: NOW - 2 * DAY }),
        gone: { id: 'gone', at: NOW, gone: true },
      },
      NOW,
    );
    const d = forDay(todos, '2026-11-13', dayOf);
    expect(d.open.map((x) => x.id)).toEqual(['late', 'today', 'any']);
    expect(d.done.map((x) => x.id)).toEqual(['did']);
    expect(d.later.map((x) => x.id)).toEqual(['soon']);
  });
});
