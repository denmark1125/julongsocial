import { describe, expect, it } from "vitest";
import { lastShootDate } from "../lastShoot";

const today = "2026-11-18";
describe("lastShootDate", () => {
  it("素材拍攝日比結案預約晚 → 用素材（大發 11-18 實例）", () => {
    const bookings = [
      { vendorId: "v", status: "completed", scheduledDate: "2026-07-24" },
      { vendorId: "v", status: "cancelled", scheduledDate: "2026-09-01" },
    ];
    const assets = [{ vendorId: "v", filmingDate: "2026-10-15" }, { vendorId: "v", filmingDate: "2026-10-20" }];
    expect(lastShootDate("v", bookings, assets, today)).toBe("2026-10-20");
  });
  it("已過日子的 booked（TimeTree 來的）算拍過；未來的、取消的、別家的不算", () => {
    const bookings = [
      { vendorId: "v", status: "booked", scheduledDate: "2026-11-10" },
      { vendorId: "v", status: "booked", scheduledDate: "2026-11-25" },
      { vendorId: "v", status: "cancelled", scheduledDate: "2026-11-15" },
      { vendorId: "x", status: "completed", scheduledDate: "2026-11-17" },
    ];
    expect(lastShootDate("v", bookings, [], today)).toBe("2026-11-10");
  });
  it("未來拍攝日的素材不算、壞日期略過、都沒有回 null", () => {
    expect(lastShootDate("v", [], [{ vendorId: "v", filmingDate: "2026-12-01" }, { vendorId: "v", filmingDate: "" }], today)).toBeNull();
  });
});
