import { defineConfig } from 'vitest/config';

// firestore.rules 的測試：要在 Firestore 模擬器裡跑，用 `npm run test:rules` 啟動。
// 一個一個檔案依序跑，避免多個測試檔同時清空同一個模擬器資料庫。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
