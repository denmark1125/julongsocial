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

// ─── 應付：剪輯師請款 ─────────────────────────────────────
// 方向跟上面的 BillingContract/BillingRecord 相反：那是客戶付我們，這是我們付剪輯師。
// 計費錨點是 Asset.cloudUploadedAt（剪輯師自己按「上傳雲端」的那一刻），
// 不是建檔日也不是發布日 —— 老闆定的規則就是「成片上傳雲端＝這支可以請款」。

/** 預設單價。實務：影片 <60 秒 750、>60 秒 900，所以剪輯師可以逐支改。 */
export const DEFAULT_EDITOR_FEE = 900;

/**
 * 這個月份之前上傳的片一律不進請款清單。
 * 交棒鏈上線後、請款功能上線前那段期間按過「上傳雲端」的片會有 cloudUploadedAt 但從沒經過請款流程，
 * 沒有這道閘，剪輯師第一次打開請款頁會看到一整串歷史片並全部勾起來送出。
 */
// 2026-08 是這套請款功能真正上線的月份，也就是計費的起點。
// 這道閘擋掉的是「上線前就有 cloudUploadedAt」的存量片——那些是用舊的 LINE＋勞報單流程
// 結清的，不該再湧進系統的第一張請款單。
// ⚠️ 這個值只有在整套功能重新上線時才需要動，平常不要改：往前調會讓已經結清的舊片重新變成可請款。
export const EDITOR_BILLING_START_MONTH = '2026-08';
export const EDITOR_INVOICING_ENABLED = false;

/**
 * 請款單明細＝送單當下的快照。
 * 之所以整份複製而不是只存 assetId：片名可能被改、IP 可能改名、素材甚至可能被刪，
 * 已經送出去的單不能被這些後續變動污染。
 */
export interface EditorInvoiceItem {
  assetId: string;
  vendorId: string;
  vendorName: string;      // 快照
  title: string;           // 快照
  cloudUploadedAt: string; // 快照（ISO）
  amount: number;          // 凍結金額
}

export interface EditorInvoice {
  id?: string;
  editorId: string;        // → editors/{id}
  editorName: string;      // 快照，剪輯師改名或被刪都不影響舊單
  submittedByUid: string;  // 送單的登入帳號 → users/{uid}
  billingMonth: string;    // YYYY-MM，取自 cloudUploadedAt 所屬月份（本地時區）
  items: EditorInvoiceItem[];
  itemCount: number;       // = items.length，列表/統計不用展開陣列
  totalAmount: number;     // = sum(items.amount)，凍結
  status: 'submitted' | 'paid' | 'void';
  submittedAt: string;
  note?: string;
  paidAt?: string;
  paidByUid?: string;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
}

export type UserRole = 'engineer' | 'manager' | 'employee' | 'editor';

export interface UserProfile {
  uid: string;
  username: string;
  email?: string;
  role: UserRole;
  displayName?: string;
  lineUserId?: string; // Linked LINE User ID
  canEditDeficitBaseline?: boolean; // 工程師以外的人要能校正「起始欠片」，需工程師個別開權限；只有工程師能勾選/取消這個欄位
  isCameraPerson?: boolean; // 藏鏡人：勾選後才會出現在廠商管理的藏鏡人指派名單裡
  assignedVendorIds?: string[]; // 剪輯師(role='editor')帳號能存取的廠商範圍，只有 role='editor' 時有意義；其他角色一律看得到全部
  // 這是從 linkedEditorId 自動同步出來的快照(廠商管理改了「負責剪輯師」就會自動更新)，不要手動編輯，
  // 唯一維護入口是廠商管理的「負責剪輯師」欄位。
  linkedEditorId?: string; // 對應到 editors/{id}，剪輯師登入帳號代表哪一位剪輯師標籤
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
  /** @deprecated 密碼改存 vendorSecrets/{vendorId}；只為舊資料遷移保留。 */
  password?: string;
}

export interface VendorSecrets {
  id?: string;
  passwords: Record<string, string>;
  updatedAt: string;
  updatedBy: string;
}

export function socialAccountKey(acc: Pick<SocialAccount, 'platform' | 'username'>): string {
  return `${acc.platform}␟${acc.username}`;
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
  linkedUserUid?: string; // 若此剪輯師有登入帳號，指向 users/{uid}；用來讓廠商管理的指派變動自動同步登入帳號的權限範圍
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
  endedAt?: string;         // YYYY-MM-DD 終止合作日期（僅 status='ended' 時有意義）。該日所屬月份(含)起不再累計新目標/短缺，
                            // 但既有欠片仍看得到、仍可用後續交付沖銷；沒填這欄的舊資料維持「整家立刻從追蹤中消失」的舊行為
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

/**
 * 交棒鏈：一支片從待剪到可排程要經過剪輯師→業主→小編數手，
 * 過去只靠 stage('raw'|'finished') + approved 兩個布林值表達，
 * 導致「這支現在球在誰手上、卡了幾天」在系統裡查不到，只能靠 LINE 對話追。
 * flowStage 就是那條交棒鏈本身；stage/approved 仍照舊維護（見 FLOW_STAGE_COMPAT），
 * 讓既有的庫存/欠片計算完全不受影響。
 */
export type AssetFlowStage =
  | 'to_edit'        // 待剪 — 球在剪輯師
  | 'client_review'  // 業主審核中 — 球在業主（剪輯師按「轉成片」後進入）
  | 'revising'       // 業主要改 — 球回剪輯師
  | 'to_upload'      // 業主已通過，待上傳雲端 — 球在剪輯師
  | 'ready';         // 可排程 — 球在小編

export type FlowOwnerRole = 'editor' | 'client' | 'social';

/** 每一棒的負責角色，用來在看板上顯示「球在誰手上」 */
export const FLOW_STAGE_OWNER: Record<AssetFlowStage, FlowOwnerRole> = {
  to_edit: 'editor',
  client_review: 'client',
  revising: 'editor',
  to_upload: 'editor',
  ready: 'social',
};

export const FLOW_STAGE_LABEL: Record<AssetFlowStage, string> = {
  to_edit: '待剪',
  client_review: '業主審核中',
  revising: '業主要改',
  to_upload: '待上傳雲端',
  ready: '可排程',
};

export const FLOW_OWNER_LABEL: Record<FlowOwnerRole, string> = {
  editor: '剪輯師',
  client: '業主',
  social: '小編',
};

/**
 * flowStage 與舊欄位的對照。每次推進 flowStage 都必須連帶寫入這組值，
 * 否則 vendorStatus 的庫存/欠片會算錯（raw=待剪素材、finished+approved=可用成片）。
 * 特別注意 'revising' 要把 stage 寫回 'raw' —— 這正是過去「退回後剪輯師看不到那支片」的破口。
 */
export const FLOW_STAGE_COMPAT: Record<AssetFlowStage, { stage: 'raw' | 'finished'; approved: boolean }> = {
  to_edit: { stage: 'raw', approved: false },
  revising: { stage: 'raw', approved: false },
  client_review: { stage: 'finished', approved: false },
  to_upload: { stage: 'finished', approved: false },
  ready: { stage: 'finished', approved: true },
};

/** 各棒停滯超過幾天就算卡住（看板轉紅、LINE 催） */
export const FLOW_STALE_DAYS: Record<AssetFlowStage, number> = {
  to_edit: 5,
  client_review: 3,
  revising: 3,
  to_upload: 2,
  ready: 7,
};

export interface FlowLogEntry {
  from?: AssetFlowStage;
  to: AssetFlowStage;
  at: string;
  byUid?: string;
  byName?: string;
  note?: string; // 例如業主退回原因
}

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
  // 作廢：這支素材不該存在（建重複了／建錯了）。跟「封存」是兩回事，別搞混：
  //   封存(archived) ＝ 業主暫時不用、可能回收；仍算剪輯師的工，**仍可請款**。
  //   作廢(voidedAt) ＝ 不請款、不算庫存、不出現在任何清單，但紀錄留著可回溯。
  // 刻意用欄位而不是加進 status enum：status 有 firestore.rules 的白名單驗證、
  // 又散在數十處判斷裡，加值的風險遠高於加欄位。
  voidedAt?: string;
  voidReason?: string;
  usedInPostId?: string;
  approved: boolean;
  /** @deprecated 拖曳排序已移除（拖一筆會覆寫整份清單且永不清除，反而讓新急件永遠排在後面）。改用 isUrgent。 */
  manualPriorityRank?: number;
  isUrgent?: boolean; // 急件：只影響這一筆、可隨時取消，看板置頂紅標
  flowStage?: AssetFlowStage; // 沒有值的是 migration 前的舊資料，用 deriveFlowStage() 推導
  flowSince?: string; // 進入目前這一棒的時間，用來算卡幾天
  revisionCount?: number; // 被業主退回過幾次
  revisionNote?: string; // 最近一次退回原因
  cloudUploadedAt?: string; // 剪輯師標記「已上傳雲端」的時間。這是請款月份的唯一認定依據，只寫一次不覆蓋
  editorFee?: number;       // 這支的剪輯費（未填＝DEFAULT_EDITOR_FEE）。納入請款單後凍結
  billableEditorId?: string; // 計費歸屬，在上傳當下定案（不能事後查 vendor.editorId，那是即時值，換剪輯師會讓舊片的請款跑掉）
  editorInvoiceId?: string;  // 已納入哪張請款單。有值＝已請款過，規則保證只能 unset→set
  flowLog?: FlowLogEntry[]; // 交棒歷程（取代過去匯出時手打、關窗即失的備註）
  submittedBy?: string; // 剪輯師送審時的 uid
  submittedAt?: string; // 剪輯師送審時間
  createdAt: string;
  createdBy: string;
}

/**
 * 用 stage/approved 反推交棒棒次。對照表是 FLOW_STAGE_COMPAT 的反向，
 * 唯一無法反推的是 client_review 與 to_upload（兩者 stage/approved 相同），
 * 一律當成 client_review（保守：假設業主還沒回覆，而不是假設已通過）。
 */
function legacyFlowStage(asset: Pick<Asset, 'stage' | 'approved'>): AssetFlowStage {
  if (asset.stage === 'raw') return 'to_edit';
  return asset.approved ? 'ready' : 'client_review';
}

/**
 * 取得一支素材目前的交棒棒次。
 *
 * ⚠️ flowStage 不是無條件可信的。2026-07-31 跑過一次 migration 把 flowStage 寫進正式站，
 * 但這套交棒鏈的程式碼至今沒有部署，線上跑的仍是只會寫 stage/approved 的舊版。
 * 因此小編在正式站按「轉為成片」「已審核」時，stage/approved 前進了，flowStage 卻停在 migration 當天的值
 * —— 已完成甚至已上傳的片，在剪輯師畫面上會變回「待剪」，逼他重按一次轉成片。
 *
 * 所以這裡改成：flowStage 只有在「跟 stage/approved 對得起來」時才採信，
 * 矛盾時一律以 stage/approved 為準（那兩個欄位是全系統都在維護的權威值）。
 * 這也讓資料自己癒合 —— 不需要每次程式碼落後就再跑一次 migration。
 */
export function deriveFlowStage(asset: Pick<Asset, 'stage' | 'approved' | 'flowStage'>): AssetFlowStage {
  const legacy = legacyFlowStage(asset);
  if (!asset.flowStage) return legacy;

  const compat = FLOW_STAGE_COMPAT[asset.flowStage];
  if (!compat) return legacy;

  // stage 可能是 undefined（更早期的資料），比照 legacyFlowStage 的判定視為 finished
  const stageMatches = (asset.stage === 'raw' ? 'raw' : 'finished') === compat.stage;
  const approvedMatches = !!asset.approved === compat.approved;

  // 對得起來才保留 flowStage —— 它比 stage/approved 多帶了資訊
  // （client_review 與 to_upload 在舊欄位上完全同值，只有 flowStage 分得出來）
  return stageMatches && approvedMatches ? asset.flowStage : legacy;
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
