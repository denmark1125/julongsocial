import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc,
  doc, 
  where,
  orderBy,
  Timestamp
} from 'firebase/firestore';
import { db } from '../firebase';
import { Vendor, BillingContract, BillingRecord, BillingService } from '../types';
import { visibleVendors } from '../lib/vendorStatus';
import EditorPayables from './EditorPayables';
import { format, parseISO, startOfMonth, endOfMonth, addMonths, subMonths, isSameMonth, isWithinInterval, startOfDay, endOfDay } from 'date-fns';
import { 
  Plus, 
  Search, 
  Filter, 
  CreditCard, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Edit2,
  Trash2,
  DollarSign,
  Calendar,
  FileDown,
  X
} from 'lucide-react';
import { BillingIcon, PaidIcon, PendingIcon, OverdueIcon } from './CustomIcons';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import toast from 'react-hot-toast';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DEFAULT_SERVICE: BillingService = { name: '短影音代操 (8支/月)', price: 30000, unit: '月' };

export default function BillingManagement() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [contracts, setContracts] = useState<BillingContract[]>([]);
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [isAddContractOpen, setIsAddContractOpen] = useState(false);
  const [editingContractId, setEditingContractId] = useState<string | null>(null);
  const [isEditRecordOpen, setIsEditRecordOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<BillingRecord | null>(null);
  const [recordEditData, setRecordEditData] = useState({ amount: 0, dueDate: '' });
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [activeView, setActiveView] = useState<'billing' | 'contracts'>('billing');
  // 應收(客戶付我們) / 應付(我們付剪輯師)。兩者方向相反、資料完全不共用，只是共用這個入口。
  const [scope, setScope] = useState<'receivable' | 'payable'>('receivable');
  
  // Form state for new contract
  const [newServices, setNewServices] = useState<BillingService[]>([DEFAULT_SERVICE]);
  const [billingDay, setBillingDay] = useState(25);
  const [startDate, setStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(addMonths(new Date(), 12), 'yyyy-MM-dd'));
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const vUnsubscribe = onSnapshot(collection(db, 'vendors'), (snapshot) => {
      setVendors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor)));
    });

    const cUnsubscribe = onSnapshot(collection(db, 'billingContracts'), (snapshot) => {
      setContracts(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BillingContract)));
    });

    const rUnsubscribe = onSnapshot(collection(db, 'billingRecords'), (snapshot) => {
      setRecords(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BillingRecord)));
    });

    setLoading(false);
    return () => {
      vUnsubscribe();
      cUnsubscribe();
      rUnsubscribe();
    };
  }, []);

  // Auto-generate records for current month when contracts or records change
  useEffect(() => {
    if (contracts.length > 0) {
      generateMonthlyRecords(true); // silent mode
    }
  }, [contracts.length, currentMonth, records.length]);

  const handleAddService = () => {
    setNewServices([...newServices, { name: '', price: 0, unit: '月' }]);
  };

  const handleRemoveService = (index: number) => {
    if (newServices.length <= 1) {
      setNewServices([{ name: '', price: 0, unit: '月' }]);
      return;
    }
    setNewServices(newServices.filter((_, i) => i !== index));
  };

  const handleServiceChange = (index: number, field: keyof BillingService, value: string | number) => {
    const updated = [...newServices];
    const finalValue = field === 'price' ? (value === '' ? 0 : Number(value)) : value;
    updated[index] = { ...updated[index], [field]: finalValue } as BillingService;
    setNewServices(updated);
  };

  const handleSubmitContract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVendorId) {
      toast.error('請選擇廠商');
      return;
    }

    const totalAmount = newServices.reduce((sum, s) => sum + s.price, 0);
    
    try {
      const contractData = {
        vendorId: selectedVendorId,
        services: newServices.filter(s => s.name),
        billingDay,
        totalAmount,
        status: 'active' as const,
        startDate,
        endDate,
        notes,
        updatedAt: new Date().toISOString()
      };

      if (editingContractId) {
        await updateDoc(doc(db, 'billingContracts', editingContractId), contractData);
        toast.success('合約更新成功');
      } else {
        await addDoc(collection(db, 'billingContracts'), {
          ...contractData,
          createdAt: new Date().toISOString()
        });
        toast.success('合約建立成功');
      }
      
      setIsAddContractOpen(false);
      resetForm();
      setActiveView('contracts');
      
      // Auto generate records after contract change
      setTimeout(() => generateMonthlyRecords(true), 500);
    } catch (error) {
      console.error('Error saving contract:', error);
      toast.error(editingContractId ? '更新合約失敗' : '建立合約失敗');
    }
  };

  const handleEditContract = (contract: BillingContract) => {
    setEditingContractId(contract.id!);
    setSelectedVendorId(contract.vendorId);
    setNewServices(contract.services);
    setBillingDay(contract.billingDay);
    setStartDate(contract.startDate);
    setEndDate(contract.endDate || '');
    setNotes(contract.notes || '');
    setIsAddContractOpen(true);
  };

  const resetForm = () => {
    setEditingContractId(null);
    setSelectedVendorId('');
    setNewServices([DEFAULT_SERVICE]);
    setBillingDay(25);
    setStartDate(format(new Date(), 'yyyy-MM-dd'));
    setEndDate(format(addMonths(new Date(), 12), 'yyyy-MM-dd'));
    setNotes('');
  };

  const togglePaymentStatus = async (record: BillingRecord) => {
    try {
      const newStatus = record.status === 'paid' ? 'pending' : 'paid';
      await updateDoc(doc(db, 'billingRecords', record.id!), {
        status: newStatus,
        paidAt: newStatus === 'paid' ? new Date().toISOString() : null
      });
      toast.success(newStatus === 'paid' ? '已標記為已收款' : '已恢復為待收款');
    } catch (error) {
      console.error('Error updating record:', error);
      toast.error('更新失敗');
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!window.confirm('確定要刪除此帳單紀錄嗎？')) return;
    try {
      await deleteDoc(doc(db, 'billingRecords', recordId));
      toast.success('帳單紀錄已刪除');
    } catch (error) {
      console.error('Error deleting record:', error);
      toast.error('刪除失敗');
    }
  };

  const handleEditRecord = (record: BillingRecord) => {
    setEditingRecord(record);
    setRecordEditData({ amount: record.amount, dueDate: record.dueDate });
    setIsEditRecordOpen(true);
  };

  const handleUpdateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord) return;
    try {
      await updateDoc(doc(db, 'billingRecords', editingRecord.id!), {
        amount: recordEditData.amount,
        dueDate: recordEditData.dueDate,
        updatedAt: new Date().toISOString()
      });
      toast.success('帳單紀錄更新成功');
      setIsEditRecordOpen(false);
      setEditingRecord(null);
    } catch (error) {
      console.error('Error updating record:', error);
      toast.error('更新失敗');
    }
  };

  const handleDeleteContract = async (contractId: string) => {
    if (!window.confirm('確定要刪除此合約嗎？這將不會刪除已生成的帳單紀錄。')) return;
    try {
      await updateDoc(doc(db, 'billingContracts', contractId), {
        status: 'ended',
        updatedAt: new Date().toISOString()
      });
      toast.success('合約已終止');
    } catch (error) {
      console.error('Error deleting contract:', error);
      toast.error('操作失敗');
    }
  };

  const generateMonthlyRecords = async (silent = false) => {
    if (isGenerating) return;
    setIsGenerating(true);
    
    try {
      const monthStr = format(currentMonth, 'yyyy-MM');
      const existingRecords = records.filter(r => r.billingMonth === monthStr);
      const activeContracts = contracts.filter(c => c.status === 'active');
      
      let createdCount = 0;
      for (const contract of activeContracts) {
        // Check if current month is within contract duration
        const contractStart = parseISO(contract.startDate);
        const contractEnd = contract.endDate ? parseISO(contract.endDate) : null;
        const monthStart = startOfMonth(currentMonth);
        const monthEnd = endOfMonth(currentMonth);

        const isWithinContract = isWithinInterval(monthStart, { 
          start: startOfDay(contractStart), 
          end: contractEnd ? endOfDay(contractEnd) : endOfDay(addMonths(new Date(), 999)) 
        }) || isSameMonth(contractStart, currentMonth);

        if (!isWithinContract) continue;

        const alreadyExists = existingRecords.some(r => r.contractId === contract.id);
        if (!alreadyExists) {
          const dueDate = format(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), contract.billingDay), 'yyyy-MM-dd');
          const recordData: Omit<BillingRecord, 'id'> = {
            vendorId: contract.vendorId,
            contractId: contract.id!,
            billingMonth: monthStr,
            dueDate,
            amount: contract.totalAmount,
            status: 'pending',
            createdAt: new Date().toISOString()
          };
          await addDoc(collection(db, 'billingRecords'), recordData);
          createdCount++;
        }
      }
      
      if (createdCount > 0 && !silent) {
        toast.success(`已生成 ${createdCount} 筆本月帳單`);
      } else if (!silent) {
        toast.error('本月帳單已全部生成或無活動合約');
      }
    } catch (error) {
      console.error('Error generating records:', error);
      if (!silent) toast.error('帳單生成失敗');
    } finally {
      setIsGenerating(false);
    }
  };

  const generateContractPDF = (contract: BillingContract) => {
    const vendor = vendors.find(v => v.id === contract.vendorId);
    const doc = new jsPDF();
    
    // Header
    doc.setFontSize(22);
    doc.text('服務合約書', 105, 20, { align: 'center' });
    
    doc.setFontSize(12);
    doc.text(`合約編號: ${contract.id?.slice(-8).toUpperCase()}`, 20, 40);
    doc.text(`簽署日期: ${format(parseISO(contract.createdAt), 'yyyy/MM/dd')}`, 20, 50);
    
    // Parties
    doc.setFontSize(14);
    doc.text('一、 合約雙方', 20, 70);
    doc.setFontSize(12);
    doc.text(`甲方 (委託方): ${vendor?.name}`, 30, 80);
    doc.text(`乙方 (執行方): 聚浪社群行銷有限公司`, 30, 90);
    
    // Services
    doc.setFontSize(14);
    doc.text('二、 服務內容與費用', 20, 110);
    
    const tableData = contract.services.map(s => [s.name, `$${s.price.toLocaleString()}`, s.unit]);
    autoTable(doc, {
      startY: 120,
      head: [['服務項目', '單價', '單位']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [90, 90, 64] }
    });
    
    // Billing
    const finalY = (doc as any).lastAutoTable.finalY + 20;
    doc.setFontSize(14);
    doc.text('三、 付款方式', 20, finalY);
    doc.setFontSize(12);
    doc.text(`1. 每月總額: $${contract.totalAmount.toLocaleString()}`, 30, finalY + 10);
    doc.text(`2. 出帳日期: 每月 ${contract.billingDay} 號`, 30, finalY + 20);
    doc.text(`3. 合約期間: ${contract.startDate} 至 ${contract.endDate || '長期合作'}`, 30, finalY + 30);
    
    if (contract.notes) {
      doc.setFontSize(14);
      doc.text('四、 其他約定事項', 20, finalY + 50);
      doc.setFontSize(12);
      const splitNotes = doc.splitTextToSize(contract.notes, 160);
      doc.text(splitNotes, 30, finalY + 60);
    }
    
    // Footer
    doc.text('甲方簽章: ____________________', 20, 260);
    doc.text('乙方簽章: ____________________', 120, 260);
    
    doc.save(`${vendor?.name}_合約書.pdf`);
    toast.success('合約 PDF 已生成');
  };

  const filteredRecords = records.filter(r => {
    const vendor = vendors.find(v => v.id === r.vendorId);
    const matchesSearch = vendor?.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesMonth = r.billingMonth === format(currentMonth, 'yyyy-MM');
    return matchesSearch && matchesMonth;
  });

  const filteredContracts = contracts.filter(c => {
    const vendor = vendors.find(v => v.id === c.vendorId);
    const matchesSearch = vendor?.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSearch && c.status !== 'ended';
  });

  const stats = {
    total: filteredRecords.reduce((sum, r) => sum + r.amount, 0),
    paid: filteredRecords.filter(r => r.status === 'paid').reduce((sum, r) => sum + r.amount, 0),
    pending: filteredRecords.filter(r => r.status === 'pending').reduce((sum, r) => sum + r.amount, 0),
    overdue: filteredRecords.filter(r => r.status === 'overdue').reduce((sum, r) => sum + r.amount, 0)
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold serif">帳務管理</h2>
          <p className="text-sm text-gray-500">
            {scope === 'receivable' ? '管理廠商合約與每月收款進度' : '剪輯師計件費用的請款與對帳'}
          </p>
        </div>
        {scope === 'receivable' && (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setIsAddContractOpen(true)}
              className="flex-1 md:flex-none bg-[#5A5A40] text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center hover:bg-[#4A4A30] transition-colors"
            >
              <Plus size={18} className="mr-2" />
              新增合約
            </button>
          </div>
        )}
      </div>

      {/* 應收(客戶付我們) vs 應付(我們付剪輯師)。兩個方向的錢放同一頁，但完全不共用資料。 */}
      <div className="flex items-center space-x-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setScope('receivable')}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-bold transition-all",
            scope === 'receivable' ? "bg-white text-[#5A5A40] shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          應收 · 客戶
        </button>
        <button
          onClick={() => setScope('payable')}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-bold transition-all",
            scope === 'payable' ? "bg-white text-[#5A5A40] shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          應付 · 剪輯師
        </button>
      </div>

      {scope === 'payable' ? <EditorPayables /> : <>

      {/* Stats Dashboard */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: '本月應收', value: stats.total, icon: BillingIcon, color: 'text-[#5A5A40]', bg: 'bg-[#5A5A40]/10' },
          { label: '已收款', value: stats.paid, icon: PaidIcon, color: 'text-[#8A8A6A]', bg: 'bg-[#8A8A6A]/10' },
          { label: '待收款', value: stats.pending, icon: PendingIcon, color: 'text-[#8B7355]', bg: 'bg-[#8B7355]/10' },
          { label: '逾期未收', value: stats.overdue, icon: OverdueIcon, color: 'text-[#A67C52]', bg: 'bg-[#A67C52]/10' }
        ].map((stat, i) => (
          <div key={i} className="bg-white p-4 rounded-2xl border border-black/5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <div className={cn("p-2 rounded-lg", stat.bg)}>
                <stat.icon className={cn("w-5 h-5", stat.color)} />
              </div>
            </div>
            <p className="text-xs text-gray-500 font-medium">{stat.label}</p>
            <p className="text-lg font-bold">${stat.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* View Tabs */}
      <div className="flex items-center space-x-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setActiveView('billing')}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-bold transition-all",
            activeView === 'billing' ? "bg-white text-[#5A5A40] shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          每月收款
        </button>
        <button
          onClick={() => setActiveView('contracts')}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-bold transition-all",
            activeView === 'contracts' ? "bg-white text-[#5A5A40] shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          合約管理 ({contracts.filter(c => c.status !== 'ended').length})
        </button>
      </div>

      {activeView === 'billing' ? (
        <>
          {/* Month Selector & Actions */}
          <div className="bg-white p-4 rounded-2xl border border-black/5 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center space-x-4">
              <button 
                onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <ChevronLeft size={20} />
              </button>
              <div className="text-center min-w-[120px]">
                <p className="text-sm font-bold">{format(currentMonth, 'yyyy年 MM月')}</p>
              </div>
              <button 
                onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <ChevronRight size={20} />
              </button>
            </div>

            <div className="flex items-center space-x-2 w-full md:w-auto">
              <div className="relative flex-1 md:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                  type="text"
                  placeholder="搜尋廠商..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                />
              </div>
              <button 
                onClick={generateMonthlyRecords}
                className="p-2 bg-[#F5F5F0] text-[#5A5A40] rounded-xl hover:bg-gray-200 transition-colors"
                title="生成本月帳單"
              >
                <Calendar size={20} />
              </button>
            </div>
          </div>

          {/* Records Table */}
          <div className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-bottom border-black/5">
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">廠商名稱</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">應收日期</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">金額</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">狀態</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5">
                  {filteredRecords.map((record) => {
                    const vendor = vendors.find(v => v.id === record.vendorId);
                    const contract = contracts.find(c => c.id === record.contractId);
                    return (
                      <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="font-bold text-sm">{vendor?.name}</p>
                          <p className="text-[10px] text-gray-400">{record.billingMonth} 帳款</p>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center text-xs text-gray-600">
                            <Calendar size={12} className="mr-1.5" />
                            {record.dueDate}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <p className="font-bold text-sm">${record.amount.toLocaleString()}</p>
                        </td>
                        <td className="px-6 py-4">
                          <span className={cn(
                            "px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                            record.status === 'paid' ? "bg-[#8A8A6A]/10 text-[#8A8A6A]" :
                            record.status === 'overdue' ? "bg-[#A67C52]/10 text-[#A67C52]" : "bg-[#8B7355]/10 text-[#8B7355]"
                          )}>
                            {record.status === 'paid' ? '已收' : record.status === 'overdue' ? '逾期' : '待收'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-3">
                            <button 
                              onClick={() => togglePaymentStatus(record)}
                              className={cn(
                                "px-3 py-1 rounded-lg text-[10px] font-bold transition-all border",
                                record.status === 'paid' 
                                  ? "bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100" 
                                  : "bg-[#5A5A40] text-white border-[#5A5A40] hover:bg-[#4A4A30] shadow-sm"
                              )}
                            >
                              {record.status === 'paid' ? '恢復為待收' : '確認收款'}
                            </button>
                            <button 
                              onClick={() => handleEditRecord(record)}
                              className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"
                              title="編輯紀錄"
                            >
                              <Edit2 size={16} />
                            </button>
                            {contract && (
                              <button 
                                onClick={() => generateContractPDF(contract)}
                                className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"
                                title="下載合約 PDF"
                              >
                                <FileDown size={16} />
                              </button>
                            )}
                            <button 
                              onClick={() => handleDeleteRecord(record.id!)}
                              className="p-1.5 hover:bg-red-50 rounded-lg text-red-400"
                              title="刪除紀錄"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredRecords.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center">
                        <p className="text-gray-400 italic text-sm mb-2">本月尚無帳務紀錄</p>
                        {contracts.length > 0 && (
                          <button 
                            onClick={generateMonthlyRecords}
                            className="text-xs font-bold text-[#5A5A40] hover:underline flex items-center justify-center mx-auto"
                          >
                            <Calendar size={14} className="mr-1" />
                            點此生成本月帳單紀錄
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Contracts List */}
          <div className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-bottom border-black/5">
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">廠商名稱</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">服務項目</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">每月金額</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">合約期間</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5">
                  {filteredContracts.map((contract) => {
                    const vendor = vendors.find(v => v.id === contract.vendorId);
                    return (
                      <tr key={contract.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="font-bold text-sm">{vendor?.name}</p>
                          <p className="text-[10px] text-gray-400">出帳日: 每月 {contract.billingDay} 號</p>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-1">
                            {contract.services.map((s, i) => (
                              <span key={i} className="px-2 py-0.5 bg-gray-100 rounded text-[10px] text-gray-600">
                                {s.name}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <p className="font-bold text-sm">${contract.totalAmount.toLocaleString()}</p>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-xs text-gray-600">{contract.startDate}</p>
                          <p className="text-[10px] text-gray-400">至 {contract.endDate || '長期'}</p>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-2">
                            <button 
                              onClick={() => handleEditContract(contract)}
                              className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"
                              title="編輯合約"
                            >
                              <Edit2 size={16} />
                            </button>
                            <button 
                              onClick={() => generateContractPDF(contract)}
                              className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"
                              title="下載合約 PDF"
                            >
                              <FileDown size={16} />
                            </button>
                            <button 
                              onClick={() => handleDeleteContract(contract.id!)}
                              className="p-1.5 hover:bg-red-50 rounded-lg text-red-400"
                              title="終止合約"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredContracts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-gray-400 italic text-sm">
                        尚無活動合約
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Add/Edit Contract Modal */}
      {isAddContractOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-[32px] shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-black/5 flex justify-between items-center bg-[#F5F5F0]">
              <h3 className="text-xl font-bold serif">{editingContractId ? '編輯服務合約' : '新增服務合約'}</h3>
              <button onClick={() => { setIsAddContractOpen(false); resetForm(); }} className="p-2 hover:bg-black/5 rounded-full">
                <X size={24} />
              </button>
            </div>
            
            <form onSubmit={handleSubmitContract} className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
              {/* Vendor Selection */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">選擇廠商</label>
                <select
                  value={selectedVendorId}
                  onChange={(e) => setSelectedVendorId(e.target.value)}
                  className="w-full p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                  required
                >
                  <option value="">請選擇廠商...</option>
                  {visibleVendors(vendors).map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>

              {/* Services List */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">服務項目與金額</label>
                  <button 
                    type="button"
                    onClick={handleAddService}
                    className="text-xs font-bold text-[#5A5A40] flex items-center"
                  >
                    <Plus size={14} className="mr-1" /> 增加項目
                  </button>
                </div>
                <div className="space-y-3">
                  {newServices.map((service, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        type="text"
                        placeholder="服務名稱 (如: 短影音代操)"
                        value={service.name}
                        onChange={(e) => handleServiceChange(idx, 'name', e.target.value)}
                        className="flex-1 p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                        required
                      />
                      <input
                        type="number"
                        placeholder="金額"
                        value={service.price}
                        onChange={(e) => handleServiceChange(idx, 'price', parseInt(e.target.value))}
                        className="w-24 md:w-32 p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                        required
                      />
                      <select
                        value={service.unit}
                        onChange={(e) => handleServiceChange(idx, 'unit', e.target.value)}
                        className="w-20 p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                      >
                        <option value="月">/月</option>
                        <option value="次">/次</option>
                        <option value="季">/季</option>
                      </select>
                      <button 
                        type="button"
                        onClick={() => handleRemoveService(idx)}
                        className="p-2 text-red-400 hover:bg-red-50 rounded-lg transition-colors"
                        disabled={newServices.length <= 1}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Contract Duration */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">合約開始日</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">合約結束日 (選填)</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                  />
                </div>
              </div>

              {/* Billing Day */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">每月出帳日 (1-31)</label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={billingDay}
                  onChange={(e) => setBillingDay(parseInt(e.target.value))}
                  className="w-full p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                  required
                />
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">合約備註 / 特別條款</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40] min-h-[100px]"
                  placeholder="例如：本合約包含每月一次的實體會議..."
                />
              </div>

              <div className="pt-4">
                <div className="bg-[#F5F5F0] p-4 rounded-2xl flex justify-between items-center mb-6">
                  <span className="text-sm font-bold text-gray-500">每月預計總額</span>
                  <span className="text-xl font-bold text-[#5A5A40]">
                    ${newServices.reduce((sum, s) => sum + (s.price || 0), 0).toLocaleString()}
                  </span>
                </div>
                <button
                  type="submit"
                  className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-lg hover:bg-[#4A4A30] transition-all"
                >
                  {editingContractId ? '確認更新合約' : '確認建立合約'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Record Modal */}
      {isEditRecordOpen && editingRecord && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-[32px] shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-black/5 flex justify-between items-center bg-[#F5F5F0]">
              <h3 className="text-xl font-bold serif">編輯帳單紀錄</h3>
              <button onClick={() => { setIsEditRecordOpen(false); setEditingRecord(null); }} className="p-2 hover:bg-black/5 rounded-full">
                <X size={24} />
              </button>
            </div>
            
            <form onSubmit={handleUpdateRecord} className="p-6 space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">應收日期</label>
                  <input
                    type="date"
                    value={recordEditData.dueDate}
                    onChange={(e) => setRecordEditData({ ...recordEditData, dueDate: e.target.value })}
                    className="w-full p-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">應收金額</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold">$</span>
                    <input
                      type="number"
                      value={recordEditData.amount}
                      onChange={(e) => setRecordEditData({ ...recordEditData, amount: parseInt(e.target.value) })}
                      className="w-full pl-8 pr-4 py-3 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#5A5A40]"
                      required
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-lg hover:bg-[#4A4A30] transition-all"
                >
                  確認更新
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </>}
    </div>
  );
}
