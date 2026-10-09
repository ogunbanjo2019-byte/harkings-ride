import { db, timestamp } from '../database/store.js';
import { env } from '../config/env.js';

const paystackTransfer = async (withdrawal) => {
  if (!env.paystackSecretKey) {
    return { 
      status: 'awaiting_provider', 
      reason: 'PAYSTACK_SECRET_KEY is not configured' 
    };
  }

  const account = withdrawal.bankAccount;
  if (!account?.accountNumber || !account?.bankCode) {
    return { 
      status: 'failed', 
      reason: 'Verified bank account details are missing' 
    };
  }

  const recipientResponse = await fetch('https://api.paystack.co/transferrecipient', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'nuban',
      name: account.accountName,
      account_number: account.accountNumber,
      bank_code: account.bankCode,
      currency: 'NGN',
    }),
  });

  const recipient = await recipientResponse.json();
  if (!recipientResponse.ok || !recipient.status) {
    throw new Error(recipient.message || 'Paystack recipient creation failed');
  }

  const transferResponse = await fetch('https://api.paystack.co/transfer', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'balance',
      amount: Math.round(Number(withdrawal.amount) * 100), // Convert to kobo
      recipient: recipient.data.recipient_code,
      reason: `SwitchRide withdrawal ${withdrawal.id}`,
      reference: `withdrawal_${withdrawal.id}`,
    }),
  });

  const transfer = await transferResponse.json();
  if (!transferResponse.ok || !transfer.status) {
    throw new Error(transfer.message || 'Paystack transfer failed');
  }

  return {
    status: 'provider_pending',
    provider: 'paystack',
    providerReference: transfer.data.reference,
    providerResponse: transfer.data,
  };
};

export const executePayout = async (withdrawalId) => {
  const withdrawal = db.withdrawals.find((item) => item.id === withdrawalId);
  
  if (!withdrawal || ['paid', 'rejected', 'reversed'].includes(withdrawal.status)) {
    return withdrawal;
  }

  const result = await paystackTransfer(withdrawal);
  
  Object.assign(withdrawal, result, {
    updatedAt: timestamp(),
  });

  return withdrawal;
};