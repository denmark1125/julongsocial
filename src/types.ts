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

export interface Vendor {
  id?: string;
  name: string;
  socialAccounts: SocialAccount[];
  postingHabits?: PostingHabit[];
  cooperationItems: CooperationItem[];
  monthlyTargetPosts?: number;
  monthlyTargetVideos?: number;
  editorId?: string;
  editorName?: string; // Keep for display/fallback
  selfPublishing?: boolean; // Vendor publishes by themselves
  aiBenchmark?: boolean;    // AI 員工（雨傘標）每日對標研究開關
  aiScript?: boolean;       // AI 員工（會攝攝）腳本生成開關
  aiPersona?: string;       // 人物設定檔（AI 寫腳本依據，同事可編輯）
  dataFbPageId?: string;    // 配對的 ip-nexus 數據帳號（ip_profiles.fb_page_id）
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
