export interface BillingService {
  name: string;
  price: number;
  unit: string; // e.g., '月', '次'
}

export interface BillingContract {
  id?: string;
  vendorId: string;
  services: BillingService[];
  billingDay: number; // 1-31
  totalAmount: number;
  status: 'active' | 'paused' | 'ended';
  startDate: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingRecord {
  id?: string;
  vendorId: string;
  contractId: string;
  billingMonth: string; // YYYY-MM
  dueDate: string; // YYYY-MM-DD
  amount: number;
  status: 'pending' | 'paid' | 'overdue';
  paidAt?: string;
  notes?: string;
  createdAt: string;
}

export type UserRole = 'engineer' | 'manager' | 'employee';

export interface UserProfile {
  uid: string;
  username: string;
  email?: string;
  role: UserRole;
  displayName?: string;
  lineUserId?: string; // Linked LINE User ID
  canEditDeficitBaseline?: boolean; // 工程師以外的人要能校正「起始欠片」，需工程師個別開權限；只有工程師能勾選/取消這個欄位
  isCameraPerson?: boolean; // 藏鏡人：勾選後才會出現在廠商管理的藏鏡人指派名單裡
  createdAt: string;
}

export interface LineUser {
  id?: string;
  lineUserId: string;
  linePictureUrl?: string;
  lineDisplayName?: string;
  UserId?: string; // Linked system user UID
  createdAt: string;
}

export interface LineConnection {
  id?: string;
  lineUserId?: string;
  linePictureUrl?: string;
  lineDisplayName?: string;
  UserId?: string; // Linked system user UID (empty string if not linked)
  createdAt?: string;
  [key: string]: any; // Allow other fields like 'timestamp' or 'isBound'
}

export interface VersionLog {
  id?: string;
  version: string;
  content: string;
  date: string;
  createdBy: string;
}

export interface SocialAccount {
  platform: string;
  username: string;
  password?: string;
}

export interface PostingHabit {
  daysOfWeek: number[]; // 0-6
  time: string; // HH:mm
  contentTypes: string[]; // 'post', 'video'
  platforms: string[];
}

export type CooperationItem = 'short_video' | 'graphic_post';

export interface Editor {
  id?: string;
  name: string;
  createdAt: string;
}

export interface PauseRecord {
  from: string;      // YYYY-MM-DD 該次冷凍起始日
  until?: string;     // YYYY-MM-DD 該次冷凍實際/預計恢復日，留空＝尚未恢復（仍在冷凍中）
}

export interface MonthlyAdjustment {
  month: string;      // YYYY-MM，只對這個月的目標生效，月份一過自動不再套用
  videoDelta: number; // 影音目標增減（可負數＝扣片），例如加贈3支填 3
  reason: string;     // 原因，例如「7月開會決議加贈3支」
  createdAt: string;
}

export interface DeficitEntry {
  month: string;   // YYYY-MM，通常是系統開始自動追蹤前、已經確定積欠的歷史月份
  owed: number;     // 該筆對起始欠片的加減，正數＝欠這麼多支、負數＝沖銷/抵銷這麼多支（直接加總進 baseline，不是delta）
  note?: string;
  createdAt: string;
}

export interface Vendor {
  id?: string;
  name: string;
  socialAccounts: SocialAccount[];
  postingHabits?: PostingHabit[];
  cooperationItems: CooperationItem[];
  monthlyTargetPosts?: number;
  monthlyTargetVideos?: number;
  cooperationStartMonth?: string; // YYYY-MM，合作正式起算月；該月之前不列入任何目標/欠片/庫存追蹤，避免新客戶還沒開始拍就先冒出欠片
  weeklyPattern?: number[]; // 長度4，[第1週,第2週,第3週,第4週]目標影音支數（自然月每7天一段，第4段吸收月底剩餘天數）；不填則用 monthlyTargetVideos/4 平均攤提
  assignedUserIds?: string[]; // 指派負責此IP的同事 uid（用於庫存警示通知過濾；engineer/manager 一律看得到全部，不需被指派）
  excludeFromStats?: boolean; // 勾選後不列入本月發文/欠片統計與提醒（內部帳號等不需追蹤進度）
  monthlyAdjustments?: MonthlyAdjustment[]; // 單月加贈/扣片紀錄（可多筆），套用在 getEffectiveMonthlyTarget，只影響該月目標與欠片，不動每週節奏
  pauseHistory?: PauseRecord[]; // 歷次冷凍期紀錄（可多次），用來判斷「某個月」是否該排除該廠商的目標/欠片計算
  deficitEntries?: DeficitEntry[]; // 逐月回填的積欠支數明細（取代單一數字，加總就是起始欠片），系統從最後一筆的下個月開始自動接著累加
  manualDeficitBaseline?: number;   // 舊版單一數字校正欄位，僅在 deficitEntries 是空的時候才會被讀取（相容尚未遷移的舊資料）
  manualDeficitUpdatedAt?: string;  // 舊版校正時間，同上，只在沒有 deficitEntries 時作為自動累加的起算月份
  editorId?: string;
  editorName?: string; // Keep for display/fallback
  selfPublishing?: boolean; // Vendor publishes by themselves
  status?: 'active' | 'paused' | 'ended'; // 不填視同 active
  pausedUntil?: string;     // YYYY-MM-DD，冷凍期預計恢復日（僅 status='paused' 時有意義）
  createdBy: string;
  createdAt: string;
}

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'pending';

export interface Post {
  id?: string;
  vendorId: string;
  assetId?: string; // Link to Asset
  title: string;
  content: string;
  status: PostStatus;
  scheduledAt: string;
  targetMonth: string; // YYYY-MM
  type: string;
  contentType: 'video' | 'post';
  postUrl?: string;
  clientConfirmed: boolean;
  internalConfirmed: boolean;
  platforms: string[];
  publishedPlatforms?: string[]; // Platforms already published
  isRecognized?: boolean; // Explicit flag for service recognition
  createdBy: string;
  createdAt: string;
}

export type AssetType = 'video' | 'post';

export interface Asset {
  id?: string;
  vendorId: string;
  editorId?: string; // Link to freelance editor
  title: string;
  url?: string;
  type: AssetType;
  stage: 'raw' | 'finished';
  filmingDate?: string;
  category?: string; // e.g., '宣傳片', '教學'
  status: 'available' | 'used' | 'archived';
  usedInPostId?: string;
  approved: boolean;
  createdAt: string;
  createdBy: string;
}

export interface DismissedHabit {
  id?: string;
  vendorId: string;
  habitTime: string;
  date: string; // YYYY-MM-DD
  createdAt: string;
}

export type BookingStatus = 'booked' | 'completed' | 'postponed' | 'cancelled';
export type BookingReason = 'client' | 'internal' | 'other';

export interface ShootBooking {
  id?: string;
  vendorId: string;
  scheduledDate: string; // YYYY-MM-DD
  status: BookingStatus;
  bookedByUid: string;
  bookedByName: string;
  reason?: BookingReason; // set when postponed/cancelled
  deliveredCount?: number; // set when completed
  previousBookingId?: string; // links to the booking this one rescheduled from
  createdAt: string;
  resolvedAt?: string;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string;
    providerInfo?: {
      providerId: string;
      displayName: string;
      email: string;
      photoUrl: string;
    }[];
  };
}
