import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  Users, 
  FileText, 
  Calendar as CalendarIcon, 
  Share2,
  LogOut, 
  Bell,
  Menu,
  X,
  Plus,
  ShieldCheck,
  History,
  Video,
  AlertTriangle,
  BellRing,
  Clock,
  Lock,
  CreditCard,
  Film,
  Scissors
} from 'lucide-react';
import { auth, db } from '../firebase';
import { signOut } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UserProfile, Post, Vendor, Asset, DismissedHabit } from '../types';
import { trackedVendors, getVideoStockAlert, getOwedVideoCount, getAvailableVideoAssets, hasVideoTrackingScope } from '../lib/vendorStatus';
import { format, parseISO, isBefore, addDays, isAfter, getDay, isSameDay, subDays } from 'date-fns';
import Logo from './Logo';
import { motion, AnimatePresence } from 'motion/react';
import ChangePasswordModal from './ChangePasswordModal';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  user: any;
  userProfile: UserProfile | null;
}

export default function Layout({ children, activeTab, setActiveTab, user, userProfile }: LayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isNotiOpen, setIsNotiOpen] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);
  const [lastReadNoti, setLastReadNoti] = useState<string>(localStorage.getItem('lastReadNoti') || new Date(0).toISOString());
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);

  useEffect(() => {
    const vUnsubscribe = onSnapshot(collection(db, 'vendors'), (snapshot) => {
      setVendors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor)));
    });
    const pUnsubscribe = onSnapshot(collection(db, 'posts'), (snapshot) => {
      setPosts(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Post)));
    });
    const aUnsubscribe = onSnapshot(collection(db, 'assets'), (snapshot) => {
      setAssets(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Asset)));
    });
    const dUnsubscribe = onSnapshot(collection(db, 'dismissedHabits'), (snapshot) => {
      setDismissedHabits(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as DismissedHabit)));
    });

    return () => {
      vUnsubscribe();
      pUnsubscribe();
      aUnsubscribe();
      dUnsubscribe();
    };
  }, []);

  // Notification Logic
  const notifications = (() => {
    const list: any[] = [];
    const now = new Date();
    const threeDaysFromNow = addDays(now, 3);

    // 1. Urgent Approvals
    posts.forEach(p => {
      const scheduledDate = parseISO(p.scheduledAt);
      if (isBefore(scheduledDate, threeDaysFromNow) && isAfter(scheduledDate, now)) {
        if (!p.internalConfirmed) {
          list.push({
            id: `urgent-int-${p.id}`,
            type: 'urgent',
            title: '待主管審核',
            content: p.title,
            time: p.scheduledAt,
            tab: 'posts',
            icon: AlertTriangle,
            color: 'text-red-500',
            bg: 'bg-red-50'
          });
        } else if (!p.clientConfirmed) {
          list.push({
            id: `urgent-cli-${p.id}`,
            type: 'urgent',
            title: '待客戶審核',
            content: p.title,
            time: p.scheduledAt,
            tab: 'posts',
            icon: AlertTriangle,
            color: 'text-orange-500',
            bg: 'bg-orange-50'
          });
        }
      }
    });

    // 2. Missing Schedules (Next 3 days)
    for (let i = 0; i < 3; i++) {
      const checkDate = addDays(now, i);
      const dayOfWeek = getDay(checkDate);
      const dateStr = format(checkDate, 'yyyy-MM-dd');
      
      trackedVendors(vendors).forEach(vendor => {
        const habits = vendor.postingHabits || [];
        const dayHabits = habits.filter(h => h.daysOfWeek.includes(dayOfWeek));

        dayHabits.forEach(habit => {
          const isDismissed = dismissedHabits.some(d => d.vendorId === vendor.id && d.habitTime === habit.time && d.date === dateStr);
          if (isDismissed) return;

          const isFulfilled = posts.some(p => 
            p.vendorId === vendor.id && p.scheduledAt &&
            (isSameDay(parseISO(p.scheduledAt), checkDate) || isSameDay(parseISO(p.scheduledAt), subDays(checkDate, 1)) || isSameDay(parseISO(p.scheduledAt), addDays(checkDate, 1)))
          );
          
          if (!isFulfilled) {
            list.push({
              id: `missing-${vendor.id}-${dateStr}-${habit.time}`,
              type: 'missing',
              title: '缺漏排程提醒',
              content: `${vendor.name} - ${format(checkDate, 'MM/dd')} ${habit.time}`,
              time: checkDate.toISOString(),
              tab: 'calendar',
              icon: BellRing,
              color: 'text-blue-500',
              bg: 'bg-blue-50'
            });
          }
        });
      });
    }

    // 3. Video Stock：'shoot'=連原始素材都不夠，急迫要拍片／'edit'=素材夠但沒剪完，催剪輯優先處理。
    // 用 hasVideoTrackingScope 而非 trackedVendors：冷凍中的廠商如果還留有舊欠片，一樣要提醒，不能因為冷凍就從通知消失
    vendors.filter(v => hasVideoTrackingScope(v, format(now, 'yyyy-MM'))).forEach(v => {
      const vendorVideoAssets = getAvailableVideoAssets(v.id!, assets, posts);
      const owed = getOwedVideoCount(v, posts, vendorVideoAssets.length);
      const alert = getVideoStockAlert(v, vendorVideoAssets, owed);
      if (alert.severity === 'shoot') {
        list.push({
          id: `stock-shoot-${v.id}`,
          type: 'stock',
          title: '需安排拍攝',
          content: `${v.name} 成片+素材共 ${alert.finishedStock + alert.rawStock} 部${alert.owed > 0 ? `，累計已欠 ${alert.owed} 支` : `，只夠撐 ${Math.max(0, Math.floor(alert.totalRunwayDays!))} 天`}`,
          time: now.toISOString(),
          tab: 'shootBookings',
          icon: Film,
          color: 'text-red-500',
          bg: 'bg-red-50'
        });
      } else if (alert.severity === 'edit') {
        list.push({
          id: `stock-edit-${v.id}`,
          type: 'stock',
          title: '催剪輯優先處理',
          content: `${v.name} 成片僅剩 ${alert.finishedStock} 部只夠撐 ${Math.max(0, Math.floor(alert.finishedRunwayDays!))} 天，有 ${alert.rawStock} 部待剪，麻煩去催剪輯師${v.editorName ? `「${v.editorName}」` : ''}優先剪`,
          time: now.toISOString(),
          tab: 'videos',
          icon: Scissors,
          color: 'text-amber-500',
          bg: 'bg-amber-50'
        });
      }
    });

    return list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  })();

  const hasUnread = notifications.length > 0 && notifications.some(n => new Date(n.time) > new Date(lastReadNoti));

  const markAsRead = () => {
    const now = new Date().toISOString();
    setLastReadNoti(now);
    localStorage.setItem('lastReadNoti', now);
    setIsNotiOpen(!isNotiOpen);
  };

  const menuItems = [
    { id: 'dashboard', label: '儀表板', icon: LayoutDashboard, roles: ['engineer', 'manager', 'employee'] },
    { id: 'vendors', label: '廠商管理', icon: Users, roles: ['engineer', 'manager', 'employee'] },
    { id: 'posts', label: '貼文管理', icon: FileText, roles: ['engineer', 'manager', 'employee'] },
    { id: 'videos', label: '素材資料庫', icon: Video, roles: ['engineer', 'manager', 'employee'] },
    { id: 'shootBookings', label: '拍攝進度', icon: Film, roles: ['engineer', 'manager', 'employee'] },
    { id: 'calendar', label: '社群日曆', icon: CalendarIcon, roles: ['engineer', 'manager', 'employee'] },
    { id: 'billing', label: '帳務管理', icon: CreditCard, roles: ['engineer', 'manager'] },
    { id: 'users', label: '員工管理', icon: ShieldCheck, roles: ['engineer', 'manager'] },
    { id: 'version', label: '版本日誌', icon: History, roles: ['engineer'] },
  ];

  const filteredMenu = menuItems.filter(item => 
    !userProfile || item.roles.includes(userProfile.role)
  );

  return (
    <div className="flex h-screen bg-[#F5F5F0] text-[#1a1a1a] font-sans overflow-hidden">
      {/* Sidebar - Desktop */}
      <aside className={cn(
        "hidden md:flex bg-white border-r border-black/5 transition-all duration-300 flex-col",
        isSidebarOpen ? "w-64" : "w-20"
      )}>
        <div className="p-6 flex items-center justify-between">
          {isSidebarOpen ? (
            <Logo className="w-8 h-8" />
          ) : (
            <Logo className="w-8 h-8" showText={false} />
          )}
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-black/5 rounded-lg ml-2">
            {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
          {filteredMenu.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "w-full flex items-center p-3 rounded-xl transition-all",
                activeTab === item.id 
                  ? "bg-[#5A5A40] text-white shadow-md" 
                  : "hover:bg-black/5 text-gray-600"
              )}
            >
              <item.icon size={20} className={cn(isSidebarOpen ? "mr-3" : "mx-auto")} />
              {isSidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-black/5">
          <div className={cn("flex flex-col", isSidebarOpen ? "px-2" : "items-center")}>
            <div className={cn("flex items-center w-full mb-2", isSidebarOpen ? "justify-between" : "justify-center")}>
              {isSidebarOpen && (
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-sm font-medium truncate">{userProfile?.displayName || user.email}</p>
                  <p className="text-[10px] font-bold text-[#5A5A40] uppercase tracking-wider">
                    {userProfile?.role === 'engineer' ? '工程師' : userProfile?.role === 'manager' ? '主管' : '員工'}
                  </p>
                </div>
              )}
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsChangePasswordOpen(true)}
                  className="p-2 text-gray-500 hover:text-[#5A5A40] hover:bg-[#F5F5F0] rounded-lg transition-colors"
                  title="修改密碼"
                >
                  <Lock size={18} />
                </button>
                <button 
                  onClick={() => signOut(auth)}
                  className="p-2 text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                  title="登出"
                >
                  <LogOut size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <ChangePasswordModal 
          isOpen={isChangePasswordOpen} 
          onClose={() => setIsChangePasswordOpen(false)} 
          userEmail={user.email}
        />
      </aside>

      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
            />
            <motion.aside 
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              className="fixed inset-y-0 left-0 w-72 bg-white z-50 md:hidden flex flex-col shadow-2xl"
            >
              <div className="p-6 flex items-center justify-between border-b border-black/5">
                <Logo className="w-8 h-8" />
                <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 hover:bg-black/5 rounded-lg">
                  <X size={24} />
                </button>
              </div>
              
              <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
                {filteredMenu.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActiveTab(item.id);
                      setIsMobileMenuOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-center p-4 rounded-2xl transition-all",
                      activeTab === item.id 
                        ? "bg-[#5A5A40] text-white shadow-lg" 
                        : "hover:bg-black/5 text-gray-600"
                    )}
                  >
                    <item.icon size={22} className="mr-4" />
                    <span className="font-bold">{item.label}</span>
                  </button>
                ))}
              </nav>

              <div className="p-6 border-t border-black/5 bg-[#F5F5F0]/30">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="font-bold truncate">{userProfile?.displayName || user.email}</p>
                    <p className="text-xs font-bold text-[#5A5A40] uppercase tracking-wider">
                      {userProfile?.role === 'engineer' ? '工程師' : userProfile?.role === 'manager' ? '主管' : '員工'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setIsChangePasswordOpen(true)}
                      className="p-3 bg-white text-gray-500 rounded-xl shadow-sm"
                    >
                      <Lock size={20} />
                    </button>
                    <button 
                      onClick={() => signOut(auth)}
                      className="p-3 bg-white text-red-500 rounded-xl shadow-sm"
                    >
                      <LogOut size={20} />
                    </button>
                  </div>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <header className="bg-white/80 backdrop-blur-md border-b border-black/5 p-4 md:p-6 sticky top-0 z-30 flex justify-between items-center shrink-0">
          <div className="flex items-center">
            <button 
              onClick={() => setIsMobileMenuOpen(true)} 
              className="p-2 mr-3 hover:bg-black/5 rounded-lg md:hidden"
            >
              <Menu size={24} />
            </button>
            <h2 className="text-xl md:text-2xl font-semibold serif truncate">
              {menuItems.find(i => i.id === activeTab)?.label}
            </h2>
          </div>
          
          <div className="flex items-center space-x-2 md:space-x-4">
            <div className="relative">
              <button 
                onClick={markAsRead}
                className={cn(
                  "p-2 text-gray-500 hover:bg-black/5 rounded-full relative transition-colors",
                  isNotiOpen && "bg-black/5 text-[#5A5A40]"
                )}
              >
                <Bell size={20} />
                {hasUnread && (
                  <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white animate-pulse"></span>
                )}
              </button>

              <AnimatePresence>
                {isNotiOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsNotiOpen(false)} />
                    <motion.div 
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      className="absolute right-0 mt-2 w-[calc(100vw-2rem)] md:w-80 bg-white rounded-3xl shadow-2xl border border-black/5 z-50 overflow-hidden"
                      style={{ maxWidth: '320px' }}
                    >
                      <div className="p-4 border-b border-black/5 bg-[#F5F5F0]/50 flex justify-between items-center">
                        <h3 className="font-bold text-sm">通知中心</h3>
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                          {notifications.length} 則提醒
                        </span>
                      </div>
                      <div className="max-h-[60vh] md:max-h-[400px] overflow-y-auto">
                        {notifications.length > 0 ? notifications.map((noti) => (
                          <button
                            key={noti.id}
                            onClick={() => {
                              setActiveTab(noti.tab);
                              setIsNotiOpen(false);
                            }}
                            className="w-full p-4 flex items-start space-x-3 hover:bg-[#F5F5F0] transition-colors border-b border-black/5 last:border-0 text-left"
                          >
                            <div className={cn("p-2 rounded-xl shrink-0", noti.bg)}>
                              <noti.icon size={16} className={noti.color} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-bold text-gray-900 mb-0.5">{noti.title}</p>
                              <p className="text-[10px] text-gray-500 line-clamp-2 mb-1">{noti.content}</p>
                              <p className="text-[8px] text-gray-400 flex items-center">
                                <Clock size={8} className="mr-1" />
                                {format(parseISO(noti.time), 'MM/dd HH:mm')}
                              </p>
                            </div>
                            {new Date(noti.time) > new Date(lastReadNoti) && (
                              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full mt-1.5 shrink-0" />
                            )}
                          </button>
                        )) : (
                          <div className="p-8 text-center text-gray-400 italic text-xs">
                            目前沒有新通知
                          </div>
                        )}
                      </div>
                      {notifications.length > 0 && (
                        <div className="p-3 bg-gray-50 text-center">
                          <button 
                            onClick={() => setIsNotiOpen(false)}
                            className="text-[10px] font-bold text-[#5A5A40] hover:underline"
                          >
                            關閉視窗
                          </button>
                        </div>
                      )}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 pb-24 md:pb-8">
          {children}
        </div>

        {/* Bottom Navigation - Mobile */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-black/5 px-4 py-2 flex justify-around items-center md:hidden z-40 pb-safe">
          {filteredMenu.slice(0, 5).map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "flex flex-col items-center p-2 rounded-xl transition-all min-w-[64px]",
                activeTab === item.id ? "text-[#5A5A40]" : "text-gray-400"
              )}
            >
              <div className={cn(
                "p-1 rounded-lg transition-all",
                activeTab === item.id ? "bg-[#5A5A40]/10" : ""
              )}>
                <item.icon size={20} />
              </div>
              <span className="text-[10px] font-bold mt-1">{item.label}</span>
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}

