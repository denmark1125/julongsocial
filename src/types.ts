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

/**
 * 剪輯費分級。60 秒是分界，由剪輯師在「交片送審」時標記，管帳（manager 以上）可再修改。
 *
 * 為什麼要有分級而不是只留一個預設價：2026-09-11 之前只有 DEFAULT_EDITOR_FEE 一個值，
 * 「<60 秒 750、>60 秒 900」只寫在這行註解裡，實際上每支都算 900，要靠剪輯師在請款頁
 * 一支一支手改成 750 —— 等於規則存在於人的記憶裡，系統完全不知道。
 */
export type DurationTier = 'under60' | 'over60';

export const EDITOR_FEE_BY_TIER: Record<DurationTier, number> = {
  under60: 750,   // 60 秒以下
  over60: 950,    // 60 秒（含）以上
};

export const DURATION_TIER_LABEL: Record<DurationTier, string> = {
  under60: '60 秒以下',
  over60: '60 秒以上',
};

/**
 * 沒有分級也沒有自訂金額時的退路，只會發生在 2026-09-11 之前建的舊素材。
 * ⚠️ 不要拿這個值當新片的預設：新片一定有 durationTier，走 EDITOR_FEE_BY_TIER。
 */
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

/**
 * 新舊帳的精確切點（台北時間）。這個時間以前上傳的片不會因為「剛好同月」就自動進請款，
 * 必須先由管理端逐支標成 legacySettlementStatus=unpaid；已用舊制付過的標成 paid。
 */
export const EDITOR_BILLING_CUTOVER_AT = '2026-08-21T00:00:00+08:00';
/** 部署與資料遷移完成前維持 false；最後一道人工開關。 */
export const EDITOR_INVOICING_ENABLED = false;
export type LegacySettlementStatus = 'paid' | 'unpaid' | 'needs_review';

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
  status: 'submitted' | 'approved' | 'payment_processing' | 'paid' | 'void';
  submittedAt: string;
  note?: string;
  approvedAt?: string;
  approvedByUid?: string;
  processingAt?: string;
  processingByUid?: string;
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
  /**
   * @deprecated 2026-08-19 起密碼改存 `vendorSecrets/{vendorId}`，見 VendorSecrets。
   * 這個欄位只為了讀舊資料而保留（尚未回填的廠商），新的存檔一律不寫它。
   * 讀密碼請走 VendorManagement 的 resolvePassword()，不要直接讀這裡。
   */
  password?: string;
}

/**
 * 客戶社群帳號的密碼，獨立成一個 collection（文件 id ＝ vendorId）。
 *
 * 為什麼不留在 vendor 文件裡：**Firestore 沒有欄位級讀取控制**。密碼只要跟廠商資料同一份
 * 文件，任何讀得到 vendor 的人就一定讀得到密碼——而 EditorAssetQueue.tsx 對每個指派廠商
 * 開的是整份文件訂閱（`{ ...snap.data() }`），所以外包剪輯師的瀏覽器裡一直都有客戶的
 * IG/FB/TikTok 明碼密碼。2026-08-19 實測：主要剪輯師負責 11 家，可讀到 11 組。
 *
 * 邊界跟 billingContracts 一致：擋 editor，內部角色照舊（小編要用客戶帳號發文）。
 */
export interface VendorSecrets {
  id?: string;
  /** key ＝ socialAccountKey(帳號)，value ＝ 明碼密碼 */
  passwords: Record<string, string>;
  updatedAt: string;
  updatedBy: string;
}

/**
 * 密碼在 VendorSecrets.passwords 裡的 key。用 platform+username 而不是陣列索引：
 * 索引會因為刪除/重排而錯位，把 A 帳號的密碼配到 B 帳號上。
 * 每次存檔都整份重建這張表，所以改帳號名稱不會留下孤兒。
 */
export function socialAccountKey(acc: Pick<SocialAccount, 'platform' | 'username'>): string {
  return `${acc.platform}␟${acc.username}`;
}

/**
 * 系統內建的發布平台。以前這份清單直接寫死在 PostManagement 的兩個選擇器裡，
 * 現在廠商管理也要用同一份，所以收成唯一出處。
 * 這裡沒有的（客戶自己的官網、小紅書…）走廠商的自訂平台，不要為了單一客戶往這裡加。
 */
export const STANDARD_PLATFORMS = ['IG', 'FB', 'TikTok', 'YT', 'LINE'];

/**
 * 這個 IP 預設發到哪些平台，依內容形式分開存。
 *
 * 為什麼要有這個：小編每次新增貼文都要重點一次平台，而這件事建檔時就已經知道了。
 * 漏點的後果不是少一個標籤——貼文詳情的「逐平台標記已發布」是照 post.platforms 畫的，
 * 平台錯了那張核可清單就是錯的，她得回頭改才對得起來。
 *
 * ⚠️ 這是**預設值不是限制**：帶進表單之後小編仍然可以逐篇增減，
 *    改了不會回頭動廠商設定，也不會影響已經存過的貼文。
 */
export interface VendorDefaultPlatforms {
  video: string[];
  post: string[];
}

/**
 * 這個廠商這種內容形式預設發哪些平台。
 *
 * 取值順序：
 * 1. `defaultPlatforms`（廠商資料卡上明確設定的，最高層級）
 * 2. 退回「發布習慣」裡那排平台 —— 老闆本來就在那裡設過，不能讓它白費，
 *    也讓還沒逐家設定的廠商維持原本的行為（不會突然變成空的）。
 *    只取合作內容含這種形式的習慣，所以短影音跟圖文可以拿到不同答案。
 * 3. 都沒有就空陣列，小編自己點（跟以前一樣，只是不再硬塞一個 IG）。
 *
 * ⚠️ 第 2 步是過渡：等每家都在廠商卡上設定好，發布習慣那排就沒人讀了，那時候才可以拆掉它。
 */
export function getVendorDefaultPlatforms(
  vendor: Pick<Vendor, 'defaultPlatforms' | 'postingHabits'> | undefined,
  contentType: 'video' | 'post'
): string[] {
  const explicit = vendor?.defaultPlatforms?.[contentType];
  if (Array.isArray(explicit) && explicit.length > 0) return [...explicit];
  return platformsFromHabits(vendor?.postingHabits, contentType);
}

/** 從發布習慣推導某種內容形式的平台（去重、保留設定順序）。 */
export function platformsFromHabits(
  habits: PostingHabit[] | undefined,
  contentType: 'video' | 'post'
): string[] {
  const out: string[] = [];
  for (const h of habits || []) {
    if (!(h.contentTypes || []).includes(contentType)) continue;
    for (const p of h.platforms || []) if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 選擇器要顯示哪些平台＝內建清單 ＋ 這個廠商用過的自訂平台。
 * `extra` 是「已經存在這筆資料上的平台」——編輯舊貼文時一定要傳，
 * 否則廠商後來把某個自訂平台拿掉，那則舊貼文的平台就會從畫面上消失（但資料還在）。
 */
export function platformOptionsFor(
  vendor: Pick<Vendor, 'defaultPlatforms' | 'postingHabits'> | undefined,
  extra: string[] = []
): string[] {
  const seen = new Set(STANDARD_PLATFORMS);
  const out = [...STANDARD_PLATFORMS];
  const habitPlatforms = (vendor?.postingHabits || []).flatMap(h => h.platforms || []);
  for (const p of [...(vendor?.defaultPlatforms?.video || []), ...(vendor?.defaultPlatforms?.post || []), ...habitPlatforms, ...extra]) {
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
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

export interface VendorTargetChange {
  fromMonth: string;  // YYYY-MM，從這個月(含)起生效，直到下一筆變更為止
  videos: number;     // 該期間每月影音支數
  posts: number;      // 該期間每月圖文篇數
  reason?: string;    // 原因，例如「8月起合約調整為4支」
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
  monthlyTargetPosts?: number;   // 現行合約的每月圖文篇數＝targetHistory 最新一筆的數字；沒有 targetHistory 的舊資料就是唯一基準
  monthlyTargetVideos?: number;  // 同上，現行合約的每月影音支數
  targetHistory?: VendorTargetChange[]; // 合約片數的逐月變更紀錄；有這欄時取代 monthlyTargetVideos/Posts 當各月基準，
                                        // 只有變動的月份才留一筆，變更只影響 fromMonth(含)之後，不回溯改寫歷史月份的目標與欠片
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
  // 這個 IP 的毛片根資料夾（例如 自媒體IP代操/又生農場/剪輯）。
  // ⚠️ 只能由人用 Google Picker 指一次，**不能靠名稱去找**：我們的授權範圍是 drive.file，
  //    看不到「不是這個 app 建立的」資料夾，用名稱查會回 404。指過一次之後才進得去。
  rawFootageFolderId?: string;
  rawFootageFolderName?: string;  // 只為了讓畫面顯示人看得懂的名字，判斷一律用 id
  selfPublishing?: boolean; // Vendor publishes by themselves
  defaultPlatforms?: VendorDefaultPlatforms; // 這個 IP 預設的發布平台（依內容形式分開），新增貼文時自動帶入；見 VendorDefaultPlatforms
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

/**
 * 透過系統傳進公司 Drive 的一個檔案。
 *
 * 為什麼是獨立的 collection 而不是掛在 Asset 上，三個理由：
 *   ① 毛片是在 Asset 存在**之前**就上傳的（一次拍攝幾十個片段，對應 0 或 1 支素材）
 *   ② 一支素材日後會有多個成片（v1、業主退回後的 v2）
 *   ③ 未來的腳本／文件小檔直接用 kind:'doc' 沿用同一張表，架構不用動
 *
 * ⚠️ 一律由 server.ts 用 admin SDK 寫入，前端只讀不寫（見 firestore.rules）。
 */
/** broll＝補充畫面。**刻意不在 ERP 產生素材**：它不是交付品，
 *  產成素材會變成幽靈庫存，還會跑進剪輯師待辦與欠片計算。 */
export type UploadKind = 'raw' | 'final' | 'doc' | 'broll';

export interface AssetUpload {
  id?: string;
  kind: UploadKind;
  /** 預留：日後若把毛片改存別的地方（B2／R2），不用改這張表的結構 */
  storage: 'drive';
  vendorId: string;
  /**
   * IP 名稱快照。理由跟 Asset.vendorName 一樣：讀得到這筆紀錄的人不一定讀得到 vendor 文件，
   * 沒有快照畫面就會顯示「未知 IP」。
   */
  vendorName?: string;
  assetId?: string;
  /** 同一次「整批上傳」共用一個 batchId，事後要一起看或一起撤銷時用得到 */
  batchId?: string;

  driveFileId: string;
  driveFolderId: string;
  webViewLink?: string;
  md5Checksum?: string;

  fileName: string;
  sizeBytes: number;
  mimeType: string;

  /** ★ 逐支備註（例如「腳本第三段要改」）。整批上傳時也是一列一個。 */
  note?: string;
  /** YYYY-MM-DD。決定歸到哪個拍攝批次資料夾，用拍攝日不是上傳日。 */
  shotAt?: string;

  /** 這支檔案屬於哪一組毛片（＝ERP 的一支素材），例如「超好吃的金磚」 */
  groupName?: string;
  /** 該組的資料夾 id。檔案最終落在這裡，不是批次夾 */
  groupFolderId?: string;
  /** 拍攝批次夾 id，例如「2026／0131」那層 */
  batchFolderId?: string;

  uploadedByUid: string;
  uploadedByName?: string;
  createdAt: string;
}

/**
 * Drive 資料夾的對照表。
 * 文件 id 是可推導的字串（v1_{vendorId}_{kind}_{YYYY-MM}），所以永遠只要一次 getDoc，
 * 不需要 query、不需要索引。
 *
 * ⚠️ 執行期一律用 folderId，**絕不用名稱去 Drive 查** —— 名稱只是給人看的。
 */
export interface DriveFolderRef {
  id?: string;
  folderId: string;
  /** 人看的完整路徑，純粹除錯用 */
  path: string;
  vendorId: string;
  kind: 'raw' | 'final';
  /** YYYY-MM */
  month: string;
  createdAt: string;
}

export interface Asset {
  id?: string;
  vendorId: string;
  /**
   * IP 名稱快照。被逐支指名到「自己沒負責的 IP」的剪輯師讀不到那家 vendor 文件
   *（規則是逐文件評估的，指名只開那一支片，不開整家 IP），
   * 沒有這個快照的話他的工作台跟請款單都會顯示「未知 IP」。
   * 改派時順手寫入；舊素材可能沒有，所以是選填。
   */
  vendorName?: string;
  editorId?: string; // Link to freelance editor
  /**
   * 認列月份（YYYY-MM）。按「標記完成」時選定，預設當月；取消完成時清空。
   *
   * 為什麼需要：有些 IP（例如杜永霖）片子做完了、但上片時間由客戶決定，遲遲沒有貼文。
   * 已交的計算原本只認貼文，所以按「完成」只會把素材從庫存扣掉、卻不算交付，
   * 欠片反而 +1 —— 等於做完一支片被罰一次。
   *
   * 有了這個欄位，已交＝貼文 ＋ 已完成且有認列月份的素材，按完成對欠片就是中性的
   * （已交+1、庫存-1，互相抵銷）。
   *
   * 防重複計算：只認 status='used' 且**沒有** usedInPostId 的素材。
   * 掛在貼文上的素材由貼文那側計算，兩邊不會同時算到同一支。
   */
  recognizedMonth?: string;
  title: string;
  url?: string;
  /**
   * 這支素材在 Drive 上那一組毛片資料夾的 id（由「上傳毛片」建立時寫入）。
   *
   * 為什麼不只靠 `url`：`url` 是給人點的（存的是資料夾 webViewLink，所有既有畫面
   * 自動就有連結），但它是字串、會被人編輯，不能拿來當資料關聯的依據。
   * 孤兒對帳、日後「成片一鍵送客戶」都要拿 id 去比對。
   * ⚠️ 一律用 id 不用資料夾名稱：名稱會被改，而且每個 IP 底下都有一個叫「剪輯」的。
   */
  driveFolderId?: string;
  /**
   * 這支素材整體的剪輯方向，例如「針對中秋檔期，顏色要黃色調」。上傳毛片時填。
   * ⚠️ 剪輯師讀得到（卡片上會顯示），所以措辭是「這支片的資訊」不是派工指令。
   */
  editingBrief?: string;
  /**
   * 每個毛片片段一個短標籤，例如 [{ fileName: 'C0031.MP4', note: '大口吃' }]。
   *
   * **刻意的反正規化**：權威紀錄在 assetUploads，但規則擋住剪輯師讀那張表
   *（`assetUploads` 是 `!isEditorRole()`），而他們正是要看這些字的人。
   * 理由跟 vendorName 快照一樣：讀得到這支素材的人不一定讀得到另一份文件。
   * 1–5 筆的小陣列，跟著 asset 一起讀，不需要動任何規則的讀取範圍。
   */
  clipNotes?: { fileName: string; note: string; kind?: 'raw' | 'broll' }[];
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
  /**
   * 影片長度分級，決定單價。剪輯師按「交片送審」時選，管帳可改。
   * 沒有值的是 2026-09-11 分級上線前的舊素材，仍走 editorFee / DEFAULT_EDITOR_FEE。
   */
  durationTier?: DurationTier;
  /**
   * 這支的剪輯費。優先序：editorFee（人工指定）→ durationTier 對照價 → DEFAULT_EDITOR_FEE。
   * 一律走 getAssetFee() 取值，不要自己 ?? 900。納入請款單後凍結。
   */
  editorFee?: number;
  billableEditorId?: string; // 計費歸屬，在上傳當下定案（不能事後查 vendor.editorId，那是即時值，換剪輯師會讓舊片的請款跑掉）
  editorInvoiceId?: string;  // 已納入哪張請款單。有值＝已請款過，規則保證只能 unset→set
  // 新舊帳盤點。切帳日前的片必須逐支確認；未填視同 needs_review，不會出現在剪輯師請款頁。
  legacySettlementStatus?: LegacySettlementStatus;
  legacySettledAt?: string;
  legacySettledAmount?: number;
  legacySettlementNote?: string;
  legacySettlementSource?: string;
  legacyReviewedAt?: string;
  legacyReviewedByUid?: string;
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

/**
 * 預排時段的「單次調整」。
 *
 * postingHabits 是「每週三 11:30」這種規則，不是資料庫裡的一筆行程——日曆上的橘色預排
 * 是照規則畫出來的，沒有實體可以搬。所以把某一次預排拖到別天時，**不能**去改廠商的
 * 習慣設定：那會連同過去每一個月的日曆一起改掉，等於竄改歷史。
 *
 * 改成記一筆單次調整，只影響 fromDate 那一次，下一週照原規則出現。
 * 定位與 dismissedHabits 完全一樣（那個是「這次不用發」，這個是「這次改天發」）。
 *
 * ⚠️ fromDate 是這個時段**原本**該出現的那天，也是它的身分證：
 *    dismissedHabits 的比對、再次拖動、拖回原位都靠它，不可以改寫成 toDate。
 */
export interface PlannedSlotMove {
  id?: string;
  vendorId: string;
  habitTime: string; // HH:mm，要連同 vendorId 才認得出是哪一個習慣時段
  fromDate: string;  // YYYY-MM-DD 原本該出現的那天
  toDate: string;    // YYYY-MM-DD 挪到哪一天
  movedBy?: string;
  createdAt: string;
  updatedAt?: string;
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
