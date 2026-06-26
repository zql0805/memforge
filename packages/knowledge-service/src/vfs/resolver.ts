// Created by dev on 2026/05/25
// P5: VFS URI 解析器 — memforge://kb/{category_path}/{slug}

export interface VfsPath {
  categoryPath: string;
  slug: string | null;
  isDirectory: boolean;
}

const VFS_SCHEME = 'memforge://kb';

export function parseVfsUri(uri: string): VfsPath | null {
  if (!uri.startsWith(VFS_SCHEME)) {
    return null;
  }

  const rawPath = uri.slice(VFS_SCHEME.length);

  if (!rawPath || rawPath === '/') {
    return { categoryPath: '/', slug: null, isDirectory: true };
  }

  const normalized = (rawPath.startsWith('/') ? rawPath : `/${rawPath}`).replace(/\/\/+/g, '/');

  if (normalized.endsWith('/')) {
    return {
      categoryPath: normalized.slice(0, -1),
      slug: null,
      isDirectory: true,
    };
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return {
      categoryPath: '/',
      slug: normalized.slice(1),
      isDirectory: false,
    };
  }

  return {
    categoryPath: normalized.slice(0, lastSlash),
    slug: normalized.slice(lastSlash + 1),
    isDirectory: false,
  };
}

export function buildVfsUri(categoryPath: string, slug?: string): string {
  const base = `${VFS_SCHEME}${categoryPath.startsWith('/') ? '' : '/'}${categoryPath}`;
  if (!slug) return `${base}/`;
  return `${base}/${slug}`;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}
