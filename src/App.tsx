import React, { useState, useEffect } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider,
  User
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import VendorManagement from './components/VendorManagement';
import PostManagement from './components/PostManagement';
import CalendarView from './components/CalendarView';
import AssetDatabase from './components/AssetDatabase';
import UserManagement from './components/UserManagement';
import VersionLogView from './components/VersionLog';
import { Toaster } from 'react-hot-toast';
import { LogIn } from 'lucide-react';
import { UserProfile, UserRole } from './types';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Fetch or create user profile
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          setUserProfile(userDoc.data() as UserProfile);
        } else {
          // Default role is employee, but first user or specific email can be engineer
          const isInitialAdmin = user.email === 'denmark1125@gmail.com';
          const newProfile: UserProfile = {
            uid: user.uid,
            email: user.email!,
            role: isInitialAdmin ? 'engineer' : 'employee',
            displayName: user.displayName || '',
            createdAt: new Date().toISOString()
          };
          await setDoc(doc(db, 'users', user.uid), newProfile);
          setUserProfile(newProfile);
        }
        setUser(user);
      } else {
        setUser(null);
        setUserProfile(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login failed:', error);
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
      <div className="h-screen flex items-center justify-center bg-[#F5F5F0] p-4">
        <div className="bg-white p-12 rounded-[40px] shadow-2xl max-w-md w-full text-center space-y-8 border border-black/5">
          <div className="space-y-2">
            <h1 className="text-4xl font-bold serif text-[#5A5A40]">聚浪社群</h1>
            <p className="text-gray-500">貼文排程與廠商管理系統</p>
          </div>
          <div className="py-4">
            <div className="w-24 h-24 bg-[#F5F5F0] rounded-3xl mx-auto flex items-center justify-center text-[#5A5A40]">
              <LogIn size={48} />
            </div>
          </div>
          <button 
            onClick={handleLogin}
            className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all flex items-center justify-center space-x-3"
          >
            <span>使用 Google 帳號登入</span>
          </button>
          <p className="text-xs text-gray-400">登入即代表您同意服務條款與隱私權政策</p>
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

