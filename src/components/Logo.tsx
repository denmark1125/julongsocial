import React from 'react';

export default function Logo({ className = "w-12 h-12", showText = true }: { className?: string, showText?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <svg viewBox="0 0 100 100" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Stylized Wave/Curve Shape */}
        <path 
          d="M20 20C20 20 60 10 80 40C100 70 60 90 40 80C20 70 10 40 20 20Z" 
          fill="#3B82F6" 
          className="opacity-90"
        />
        <path 
          d="M30 40C30 40 70 30 85 55C100 80 70 95 50 85C30 75 25 55 30 40Z" 
          fill="#60A5FA" 
          className="opacity-80"
        />
        {/* Stylized 'J' or 'L' curve */}
        <path 
          d="M45 25C55 25 65 35 65 50C65 65 55 75 45 75" 
          stroke="white" 
          strokeWidth="8" 
          strokeLinecap="round"
          className="opacity-60"
        />
      </svg>
      {showText && (
        <div className="flex flex-col leading-none">
          <span className="text-xl font-black tracking-tighter text-[#1a1a1a] font-sans">聚浪</span>
          <span className="text-[10px] font-bold tracking-widest text-gray-500 uppercase">Julang Agency</span>
        </div>
      )}
    </div>
  );
}
