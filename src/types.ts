export type UserRole = 'engineer' | 'manager' | 'employee';

export interface UserProfile {
  uid: string;
  username: string;
  email?: string;
  role: UserRole;
  displayName?: string;
  createdAt: string;
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

export interface Vendor {
  id?: string;
  name: string;
  socialAccounts: SocialAccount[];
  postingHabits?: PostingHabit[];
  cooperationItems: CooperationItem[];
  monthlyTargetPosts?: number;
  monthlyTargetVideos?: number;
  createdBy: string;
  createdAt: string;
}

export type PostStatus = 'draft' | 'scheduled' | 'published';

export interface Post {
  id?: string;
  vendorId: string;
  assetId?: string; // Link to Asset
  title: string;
  content: string;
  status: PostStatus;
  scheduledAt: string;
  type: string;
  contentType: 'video' | 'post';
  postUrl?: string;
  clientConfirmed: boolean;
  internalConfirmed: boolean;
  platforms: string[];
  createdBy: string;
  createdAt: string;
}

export type AssetType = 'video' | 'post';

export interface Asset {
  id?: string;
  vendorId: string;
  title: string;
  url?: string;
  type: AssetType;
  category?: string; // e.g., '宣傳片', '教學'
  status: 'available' | 'used';
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
  };
}
