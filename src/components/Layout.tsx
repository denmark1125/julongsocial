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
  Video
} from 'lucide-react';
import { auth } from '../firebase';
import { signOut } from 'firebase/auth';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UserProfile } from '../types';

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
          {isSidebarOpen && <h1 className="text-xl font-bold text-[#5A5A40] serif">聚浪社群</h1>}
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-black/5 rounded-lg">
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
          <div className={cn("flex items-center", isSidebarOpen ? "px-2" : "justify-center")}>
            {isSidebarOpen && (
              <div className="flex-1 min-w-0 mr-3">
                <p className="text-sm font-medium truncate">{user.email}</p>
                <p className="text-[10px] font-bold text-[#5A5A40] uppercase tracking-wider">
                  {userProfile?.role === 'engineer' ? '工程師' : userProfile?.role === 'manager' ? '主管' : '員工'}
                </p>
              </div>
            )}
            <button 
              onClick={() => signOut(auth)}
              className="p-2 text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="登出"
            >
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <header className="bg-white/80 backdrop-blur-md border-bottom border-black/5 p-6 sticky top-0 z-10 flex justify-between items-center">
          <h2 className="text-2xl font-semibold serif">
            {menuItems.find(i => i.id === activeTab)?.label}
          </h2>
          <div className="flex items-center space-x-4">
            <button className="p-2 text-gray-500 hover:bg-black/5 rounded-full relative">
              <Bell size={20} />
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
            </button>
          </div>
        </header>

        <div className="p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

