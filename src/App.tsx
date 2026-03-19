import React, { useState, useEffect } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  User
} from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, query, limit } from 'firebase/firestore';
import { auth, db } from './firebase';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import VendorManagement from './components/VendorManagement';
import PostManagement from './components/PostManagement';
import CalendarView from './components/CalendarView';
import AssetDatabase from './components/AssetDatabase';
import UserManagement from './components/UserManagement';
import VersionLogView from './components/VersionLog';
import Logo from './components/Logo';
import { Toaster } from 'react-hot-toast';
import { LogIn, Mail, Lock, User as UserIcon } from 'lucide-react';
import { UserProfile, UserRole } from './types';
import toast from 'react-hot-toast';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [isFirstUser, setIsFirstUser] = useState(false);

  useEffect(() => {
    const checkFirstUser = async () => {
      try {
        const q = query(collection(db, 'users'), limit(1));
        const snapshot = await getDocs(q);
        const empty = snapshot.empty;
        setIsFirstUser(empty);
        if (empty) {
          setIsLogin(false);
          setUsername('David');
          setPassword('11251125');
          setEmail('denmark1125@gmail.com');
          setDisplayName('David');
        }
      } catch (error) {
        console.error('Error checking first user:', error);
      }
    };
    checkFirstUser();

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          if (userDoc.exists()) {
            setUserProfile(userDoc.data() as UserProfile);
            setUser(user);
          } else {
            // Check if this is the very first user trying to register
            // Or if it's the hardcoded admin email
            const isInitialAdmin = user.email === 'denmark1125@gmail.com' || isFirstUser;
            
            if (isInitialAdmin) {
              const newProfile: UserProfile = {
                uid: user.uid,
                username: username || (user.email?.split('@')[0] || 'admin'),
                email: user.email || email || '',
                role: 'engineer',
                displayName: user.displayName || displayName || '系統管理員',
                createdAt: new Date().toISOString()
              };
              await setDoc(doc(db, 'users', user.uid), newProfile);
              setUserProfile(newProfile);
              setUser(user);
            } else {
              // Not an authorized user
              await auth.signOut();
              toast.error('您的帳號尚未被授權，請聯繫管理員設定帳號。');
              setUser(null);
              setUserProfile(null);
            }
          }
        } catch (error) {
          console.error('Error fetching user profile:', error);
          await auth.signOut();
          toast.error('登入發生錯誤，請稍後再試。');
        }
      } else {
        setUser(null);
        setUserProfile(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [isFirstUser]);

  const handleUsernameLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Map David to the real admin email, others to dummy domain
      const loginEmail = username.toLowerCase() === 'david' 
        ? 'denmark1125@gmail.com' 
        : `${username.toLowerCase()}@forest.system`;
        
      await signInWithEmailAndPassword(auth, loginEmail, password);
    } catch (error: any) {
      console.error('Login failed:', error);
      if (error.code === 'auth/operation-not-allowed') {
        toast.error('系統尚未啟用帳號密碼登入，請聯繫管理員或使用 Google 登入。', { duration: 5000 });
      } else {
        toast.error('登入失敗：帳號或密碼錯誤');
      }
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFirstUser && username.toLowerCase() !== 'david') {
      toast.error('目前僅開放管理員手動新增帳號');
      return;
    }
    if (!username || !password || !displayName) {
      toast.error('請填寫必要欄位');
      return;
    }
    try {
      // Map David to the real admin email, others to dummy domain
      const loginEmail = username.toLowerCase() === 'david' 
        ? 'denmark1125@gmail.com' 
        : `${username.toLowerCase()}@forest.system`;

      const userCredential = await createUserWithEmailAndPassword(auth, loginEmail, password);
      const user = userCredential.user;
      
      const newProfile: UserProfile = {
        uid: user.uid,
        username: username,
        email: username.toLowerCase() === 'david' ? 'denmark1125@gmail.com' : (email || ''),
        role: 'engineer',
        displayName: displayName,
        createdAt: new Date().toISOString()
      };
      await setDoc(doc(db, 'users', user.uid), newProfile);
      setUserProfile(newProfile);
      setUser(user);
      toast.success('管理員帳號註冊成功');
    } catch (error: any) {
      console.error('Registration failed:', error);
      if (error.code === 'auth/operation-not-allowed') {
        toast.error('系統尚未啟用帳號密碼註冊，請先在 Firebase 控制台啟用 Email/Password 供應商。', { duration: 6000 });
      } else {
        toast.error(`註冊失敗：${error.message}`);
      }
    }
  };

  const handleGoogleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      console.error('Login failed:', error);
      if (error.code !== 'auth/popup-closed-by-user') {
        toast.error('Google 登入失敗');
      }
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#F5F5F0]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#5A5A40]"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F5F5F0] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-[#5A5A40]/10">
          <div className="flex flex-col items-center mb-8">
            <div className="w-20 h-20 bg-[#5A5A40] rounded-2xl flex items-center justify-center mb-4 shadow-lg">
              <Logo className="w-12 h-12 text-white" showText={false} />
            </div>
            <h1 className="text-2xl font-serif font-bold text-[#5A5A40]">聚浪社群排程系統</h1>
            <p className="text-[#8B7355] mt-2 text-center">請登入以開始管理您的社群素材</p>
          </div>

          <form onSubmit={handleUsernameLogin} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-bold text-gray-600 ml-1">帳號</label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[#8B7355]" />
                <input
                  type="text"
                  placeholder="請輸入您的帳號"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-[#F5F5F0] border-none rounded-xl focus:ring-2 focus:ring-[#5A5A40] transition-all"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-gray-600 ml-1">密碼</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[#8B7355]" />
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-[#F5F5F0] border-none rounded-xl focus:ring-2 focus:ring-[#5A5A40] transition-all"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full bg-[#5A5A40] text-white py-4 rounded-xl font-bold hover:bg-[#4A4A30] transition-all shadow-lg flex items-center justify-center gap-2 mt-6"
            >
              <LogIn className="w-5 h-5" />
              登入系統
            </button>
          </form>

          <div className="mt-8">
            <div className="relative mb-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#8B7355]/20"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-[#8B7355]">或使用 Google 登入</span>
              </div>
            </div>

            <button
              onClick={handleGoogleLogin}
              className="w-full bg-white border border-[#8B7355]/20 text-[#5A5A40] py-3 rounded-xl font-medium hover:bg-[#F5F5F0] transition-all flex items-center justify-center gap-2"
            >
              <img src="https://www.google.com/favicon.ico" alt="Google" className="w-5 h-5" />
              Google 帳號登入
            </button>
            <p className="mt-4 text-center text-xs text-[#8B7355]/60 italic">
              註：Google 帳號亦須經管理員授權方可登入
            </p>
          </div>
          
          <p className="mt-8 text-center text-[10px] text-[#8B7355]/40 uppercase tracking-widest">
            Forest Asset Management System v2.0
          </p>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard setActiveTab={setActiveTab} />;
      case 'vendors': return <VendorManagement />;
      case 'posts': return <PostManagement />;
      case 'calendar': return <CalendarView />;
      case 'videos': return <AssetDatabase />;
      case 'users': return <UserManagement currentUserRole={userProfile?.role || 'employee'} />;
      case 'version': return <VersionLogView />;
      default: return <Dashboard setActiveTab={setActiveTab} />;
    }
  };

  return (
    <>
      <Toaster position="top-right" />
      <Layout user={user} userProfile={userProfile} activeTab={activeTab} setActiveTab={setActiveTab}>
        {renderContent()}
      </Layout>
    </>
  );
}

