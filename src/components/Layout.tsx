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
  AlertCircle,
  BellRing,
  Clock,
  Lock
} from 'lucide-react';
import { auth, db } from '../firebase';
import { signOut } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UserProfile, Post, Vendor, Asset, DismissedHabit } from '../types';
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
      
      vendors.forEach(vendor => {
        const habits = vendor.postingHabits || [];
        const dayHabits = habits.filter(h => h.daysOfWeek.includes(dayOfWeek));
        
        dayHabits.forEach(habit => {
          const isDismissed = dismissedHabits.some(d => d.vendorId === vendor.id && d.habitTime === habit.time && d.date === dateStr);
          if (isDismissed) return;

          const isFulfilled = posts.some(p => 
            p.vendorId === vendor.id && 
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

    // 3. Low Stock
    vendors.forEach(v => {
      const stock = assets.filter(a => a.vendorId === v.id && a.type === 'video' && a.status === 'available').length;
      if (stock < 2) {
        list.push({
          id: `stock-${v.id}`,
          type: 'stock',
          title: '影片庫存不足',
          content: `${v.name} 目前僅剩 ${stock} 部影片`,
          time: now.toISOString(),
          tab: 'videos',
          icon: AlertCircle,
          color: 'text-purple-500',
          bg: 'bg-purple-50'
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
    { id: 'calendar', label: '社群日曆', icon: CalendarIcon, roles: ['engineer', 'manager', 'employee'] },
    { id: 'users', label: '員工管理', icon: ShieldCheck, roles: ['engineer', 'manager'] },
    { id: 'version', label: '版本日誌', icon: History, roles: ['engineer'] },
  ];

  const filteredMenu = menuItems.filter(item => 
    !userProfile || item.roles.includes(userProfile.role)
  );

  return (
    <div className="flex h-screen bg-[#F5F5F0] text-[#1a1a1a] font-sans">
      {/* Sidebar */}
      <aside className={cn(
        "bg-white border-r border-black/5 transition-all duration-300 flex flex-col",
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

        <nav className="flex-1 px-4 space-y-2">
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

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <header className="bg-white/80 backdrop-blur-md border-bottom border-black/5 p-6 sticky top-0 z-10 flex justify-between items-center">
          <h2 className="text-2xl font-semibold serif">
            {menuItems.find(i => i.id === activeTab)?.label}
          </h2>
          <div className="flex items-center space-x-4">
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
                    <div className="fixed inset-0 z-20" onClick={() => setIsNotiOpen(false)} />
                    <motion.div 
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      className="absolute right-0 mt-2 w-80 bg-white rounded-3xl shadow-2xl border border-black/5 z-30 overflow-hidden"
                    >
                      <div className="p-4 border-b border-black/5 bg-[#F5F5F0]/50 flex justify-between items-center">
                        <h3 className="font-bold text-sm">通知中心</h3>
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                          {notifications.length} 則提醒
                        </span>
                      </div>
                      <div className="max-h-[400px] overflow-y-auto">
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

        <div className="p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

