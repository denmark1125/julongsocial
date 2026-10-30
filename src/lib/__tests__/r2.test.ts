import { describe, expect, it } from 'vitest';
import { objectUrl, reviewObjectKey } from '../r2';

describe('reviewObjectKey', () => {
  it('依 素材/版本/亂數 放', () => expect(reviewObjectKey('a1', 2, '.MOV', 'xyz')).toBe('review/a1/v2-xyz.mov'));
  it('怪副檔名一律當 mp4', () => expect(reviewObjectKey('a1', 1, '.exe&', 'xyz')).toBe('review/a1/v1-xyz.mp4'));
});

describe('objectUrl', () => {
  it('每段編碼、保留斜線', () => {
    process.env.R2_ACCOUNT_ID = 'acc'; process.env.R2_BUCKET = 'b';
    expect(objectUrl('review/a 1/v1.mp4')).toBe('https://acc.r2.cloudflarestorage.com/b/review/a%201/v1.mp4');
  });
});
