import { defineConfig } from 'vitest/config';

// 自動測試只測「不碰 Firebase 的純函式」（src/lib 的商業邏輯）。
// 時區固定台北：剪輯期限、月份歸屬都是用本地時間算的，CI 機器預設是 UTC。
process.env.TZ = 'Asia/Taipei';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
