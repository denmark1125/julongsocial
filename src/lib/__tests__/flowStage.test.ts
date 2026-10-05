import { describe, expect, it } from 'vitest';
import { AssetFlowStage, deriveFlowStage, FLOW_STAGE_COMPAT } from '../../types';

// 交棒棒次的判定表。flowStage 只有在跟 stage/approved 對得起來時才採信（types.ts 的註解有原因）。
// 之後要把各畫面改成統一透過入口函式判斷狀態，這張表就是「行為不能變」的依據。

const STAGES: (('raw' | 'finished') | undefined)[] = ['raw', 'finished', undefined];
const APPROVED = [true, false];
const FLOW: (AssetFlowStage | undefined)[] = [undefined, 'to_edit', 'client_review', 'revising', 'to_upload', 'ready'];

function expected(stage: 'raw' | 'finished' | undefined, approved: boolean, flow: AssetFlowStage | undefined): AssetFlowStage {
  const legacy: AssetFlowStage = stage === 'raw' ? 'to_edit' : approved ? 'ready' : 'client_review';
  if (!flow) return legacy;
  const c = FLOW_STAGE_COMPAT[flow];
  const matches = (stage === 'raw' ? 'raw' : 'finished') === c.stage && approved === c.approved;
  return matches ? flow : legacy;
}

describe('deriveFlowStage 全組合', () => {
  for (const stage of STAGES) {
    for (const approved of APPROVED) {
      for (const flow of FLOW) {
        it(`stage=${stage ?? '(無)'} approved=${approved} flowStage=${flow ?? '(無)'}`, () => {
          expect(deriveFlowStage({ stage: stage as 'raw', approved, flowStage: flow })).toBe(expected(stage, approved, flow));
        });
      }
    }
  }

  it('幾個關鍵情境寫死，避免上面的 expected() 跟著被改錯', () => {
    expect(deriveFlowStage({ stage: 'raw', approved: false })).toBe('to_edit');
    expect(deriveFlowStage({ stage: 'raw', approved: false, flowStage: 'revising' })).toBe('revising');
    expect(deriveFlowStage({ stage: 'finished', approved: false, flowStage: 'to_upload' })).toBe('to_upload');
    expect(deriveFlowStage({ stage: 'finished', approved: true })).toBe('ready');
    // 舊版只寫 stage/approved：flowStage 停在 to_edit 但已經轉成片 → 以舊欄位為準
    expect(deriveFlowStage({ stage: 'finished', approved: false, flowStage: 'to_edit' })).toBe('client_review');
    // 沒有 stage 的老資料視為成片
    expect(deriveFlowStage({ stage: undefined as unknown as 'raw', approved: false })).toBe('client_review');
  });
});
