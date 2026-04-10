import React, { useState, useEffect } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  User
} from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, query, limit, getDocFromServer } from 'firebase/firestore';
import { auth, db } from './firebase';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import VendorManagement from './components/VendorManagement';
import PostManagement from './components/PostManagement';
import CalendarView from './components/CalendarView';
import AssetDatabase from './components/AssetDatabase';
import UserManagement from './components/UserManagement';
import BillingManagement from './components/BillingManagement';
import VersionLogView from './components/VersionLog';
import Logo from './components/Logo';
import { Toaster } from 'react-hot-toast';
import { LogIn, Mail, Lock, User as UserIcon } from 'lucide-react';
import { UserProfile, UserRole } from './types';
import toast from 'react-hot-toast';
import { PASSWORD_SUFFIX, ADMIN_USERNAME, ADMIN_EMAIL, INITIAL_ADMIN_REAL_EMAIL } from './constants';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    // Connection test as per instructions
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        console.log("Firestore connection test successful.");
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. The client is offline.");
          toast.error("Firebase 連線失敗，請檢查網路或設定。");
        }
        // Skip logging for other errors, as this is simply a connection test.
      }
    }
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          if (userDoc.exists()) {
            setUserProfile(userDoc.data() as UserProfile);
            setUser(user);
          } else {
            // Check if this is the hardcoded admin email or the internal admin email
            const isInitialAdmin = user.email === INITIAL_ADMIN_REAL_EMAIL || user.email === ADMIN_EMAIL;
            
            if (isInitialAdmin) {
              const newProfile: UserProfile = {
                uid: user.uid,
                username: 'David',
                email: 'denmark1125@gmail.com',
                role: 'engineer',
                displayName: 'David',
                createdAt: new Date().toISOString()
              };
              await setDoc(doc(db, 'users', user.uid), newProfile);
              setUserProfile(newProfile);
              setUser(user);
            } else {
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
  }, []);

  const handleUsernameLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username || !password) {
      toast.error('請輸入帳號與密碼');
      return;
    }

    const loginEmail = username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
      ? ADMIN_EMAIL
      : `${username.toLowerCase()}@forest.system`;
    
    // Support any password length by adding a suffix internally
    const securePassword = password + PASSWORD_SUFFIX;

    try {
      await signInWithEmailAndPassword(auth, loginEmail, securePassword);
    } catch (error: any) {
      console.error('Login failed:', error);
      
      // Special case for initial David setup
      if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === '1125' && (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential')) {
        try {
          const userCredential = await createUserWithEmailAndPassword(auth, loginEmail, securePassword);
          const user = userCredential.user;
          const newProfile: UserProfile = {
            uid: user.uid,
            username: ADMIN_USERNAME,
            email: ADMIN_EMAIL,
            role: 'engineer',
            displayName: ADMIN_USERNAME,
            createdAt: new Date().toISOString()
          };
          await setDoc(doc(db, 'users', user.uid), newProfile);
          setUserProfile(newProfile);
          setUser(user);
          toast.success('管理員帳號初始化成功');
          return;
        } catch (createError: any) {
          if (createError.code === 'auth/email-already-in-use') {
             toast.error('登入失敗：帳號或密碼錯誤');
             return;
          }
          console.error('Initial setup failed:', createError);
        }
      }

      if (error.code === 'auth/operation-not-allowed') {
        toast.error('系統尚未啟用帳號密碼登入，請聯繫管理員。', { duration: 5000 });
      } else if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        toast.error('登入失敗：帳號或密碼錯誤');
      } else {
        toast.error(`登入失敗：${error.message}`);
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
      case 'billing': return <BillingManagement />;
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

