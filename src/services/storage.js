import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
let client;

const storageClient = () => {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    return null;
  }
  
  client ||= createClient(env.supabaseUrl, env.supabaseServiceRoleKey, { 
    auth: { 
      persistSession: false, 
      autoRefreshToken: false 
    } 
  });
  
  return client;
};

export const validateUpload = (file, allowedTypes = env.allowedUploadMimeTypes) => {
  if (!file) {
    throw Object.assign(new Error('File is required'), { 
      status: 400, 
      code: 'FILE_REQUIRED' 
    });
  }
  
  if (!allowedTypes.includes(file.mimetype)) {
    throw Object.assign(new Error('Unsupported file type'), { 
      status: 415, 
      code: 'UNSUPPORTED_FILE_TYPE' 
    });
  }
  
  if (!file.buffer?.length || file.size > env.uploadMaxBytes) {
    throw Object.assign(new Error('File is empty or too large'), { 
      status: 413, 
      code: 'FILE_TOO_LARGE' 
    });
  }
};

export const storePrivateFile = async ({ path, file }) => {
  validateUpload(file);
  
  const supabase = storageClient();
  if (!supabase) {
    if (env.isProduction) {
      throw Object.assign(new Error('Private document storage is not configured'), { 
        status: 503, 
        code: 'STORAGE_NOT_CONFIGURED' 
      });
    }
    return { bucket: env.storageBucket, path, stored: false };
  }

  const { error } = await supabase.storage
    .from(env.storageBucket)
    .upload(path, file.buffer, { 
      contentType: file.mimetype, 
      upsert: false 
    });

  if (error) {
    throw Object.assign(new Error(`Private file upload failed: ${error.message}`), { 
      status: 502, 
      code: 'STORAGE_UPLOAD_FAILED' 
    });
  }

  return { bucket: env.storageBucket, path, stored: true };
};

export const signedPrivateUrl = async (path, expiresIn = env.signedUrlTtlSeconds) => {
  const supabase = storageClient();
  if (!supabase) return null;

  const { data, error } = await supabase.storage
    .from(env.storageBucket)
    .createSignedUrl(path, expiresIn);

  if (error) {
    throw Object.assign(new Error(`Signed URL creation failed: ${error.message}`), { 
      status: 502, 
      code: 'STORAGE_SIGNED_URL_FAILED' 
    });
  }

  return data.signedUrl;
};

export const downloadPrivateFile = async (path) => {
  const supabase = storageClient();
  if (!supabase) {
    throw Object.assign(new Error('Private document storage is not configured'), { 
      status: 503, 
      code: 'STORAGE_NOT_CONFIGURED' 
    });
  }

  const { data, error } = await supabase.storage
    .from(env.storageBucket)
    .download(path);

  if (error || !data) {
    throw Object.assign(new Error(`Private file download failed: ${error?.message || 'file unavailable'}`), { 
      status: 502, 
      code: 'STORAGE_DOWNLOAD_FAILED' 
    });
  }

  return new Uint8Array(await data.arrayBuffer());
};