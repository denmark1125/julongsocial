import { addDoc, collection, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { format } from 'date-fns';
import { auth, db } from '../firebase';
import { Vendor } from '../types';
import { defaultSlotTime, PlannedSlot } from './plannedSlots';

/**
 * 手動加／改／刪一個發片日（extraSlots）。社群日曆和排上片日拖拉板共用，兩邊寫法才會一樣。
 * 為什麼有這個：見 types.ts 的 ExtraSlot。
 */
export async function addExtraSlot(vendor: Pick<Vendor, 'id' | 'postingHabits'>, day: Date): Promise<void> {
  await addDoc(collection(db, 'extraSlots'), {
    vendorId: vendor.id,
    date: format(day, 'yyyy-MM-dd'),
    time: defaultSlotTime(vendor),
    contentType: 'video',
    createdBy: auth.currentUser?.uid || '',
    createdAt: new Date().toISOString(),
  });
}

export async function moveExtraSlot(extraId: string, day: Date): Promise<void> {
  await updateDoc(doc(db, 'extraSlots', extraId), { date: format(day, 'yyyy-MM-dd') });
}

export async function removeExtraSlot(extraId: string): Promise<void> {
  await deleteDoc(doc(db, 'extraSlots', extraId));
}

/**
 * 「這次不發」：刪掉一個發片日。社群日曆和排上片日拖拉板共用（2026-10-22 拖拉板加 ×）。
 * 手動加的那格直接刪那筆；週規則畫出來的記一筆 dismissedHabits。
 * ⚠️ 記的日期一律是 fromDate（原本該出現的那天）而不是它現在被挪到哪一天：
 *    fromDate 才是這個時段的身分，這樣舊資料也完全對得上，不需要 migration。
 */
export async function dismissPlannedSlot(slot: Pick<PlannedSlot, 'vendorId' | 'time' | 'fromDate' | 'moveId' | 'extraId'>): Promise<void> {
  if (slot.extraId) {
    await removeExtraSlot(slot.extraId);
    return;
  }
  await addDoc(collection(db, 'dismissedHabits'), {
    vendorId: slot.vendorId,
    habitTime: slot.time,
    date: slot.fromDate,
    createdAt: new Date().toISOString(),
  });
  // 已經不顯示了，調整紀錄留著只會變成孤兒資料
  if (slot.moveId) {
    try {
      await deleteDoc(doc(db, 'plannedSlotMoves', slot.moveId));
    } catch (cleanupError) {
      console.warn('Dismissed slot but failed to clean up its move record:', cleanupError);
    }
  }
}
