import { describe, expect, it } from 'vitest';
import { guessPostForTitle, titleSimilarity } from '../postMatch';

describe('guessPostForTitle', () => {
  const cands = [
    { id: 'a', title: '蘑菇滿滿的超大披薩！' },
    { id: 'b', title: '高雄這間港式CP超高' },
    { id: 'c', title: '百大青農頒獎' },
  ];

  it('藏鏡人取的短名稱整個包含在小編標題裡 → 猜得到', () => {
    expect(guessPostForTitle('披薩', cands)).toBe('a');
  });

  it('標點、空白不算（正式資料常見）', () => {
    expect(titleSimilarity('2024特斯拉model Y 現折100 香爆', '2024特斯拉model Y現折100香爆')).toBe(1);
  });

  it('前面多了日期也猜得到（「20260930百大青農畫面」→「百大青農頒獎」）', () => {
    expect(guessPostForTitle('20260930百大青農畫面', cands)).toBe('c');
  });

  it('都不像 → 不預選', () => {
    expect(guessPostForTitle('老闆的一天', cands)).toBe('');
  });
});
