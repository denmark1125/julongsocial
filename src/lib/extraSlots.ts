import { addDoc, collection, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { format } from 'date-fns';
import { auth, db } from '../firebase';
import { Vendor } from '../types';
import { defaultSlotTime } from './plannedSlots';

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
