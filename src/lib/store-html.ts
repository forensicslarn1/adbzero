import DOMPurify from 'dompurify'

const STORE_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a',
]

const STORE_ALLOWED_ATTR = [
  'href', 'title', 'target', 'rel',
]

const ALLOWED_URI = /^(?:(?:https?|mailto|tel):|\/|#)/i

function sanitizeStoreFragment(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: STORE_ALLOWED_TAGS,
    ALLOWED_ATTR: STORE_ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_TAGS: ['script', 'style', 'object', 'embed', 'form', 'iframe', 'img'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    RETURN_TRUSTED_TYPE: false,
  })
}

export function sanitizeStoreHtml(input: string): string {
  const sanitized = sanitizeStoreFragment(input)
  if (typeof window === 'undefined') return sanitized

  const doc = new DOMParser().parseFromString(`<div id="store-root">${sanitized}</div>`, 'text/html')
  const root = doc.getElementById('store-root')
  if (!root) return sanitized

  const links = root.querySelectorAll('a')
  for (const link of links) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noreferrer noopener')
  }

  return root.innerHTML
}

export function extractStorePlainText(input: string | undefined | null): string {
  if (!input) return ''

  const sanitized = sanitizeStoreFragment(input)
  if (typeof window === 'undefined') {
    return sanitized.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const doc = new DOMParser().parseFromString(`<div id="store-root">${sanitized}</div>`, 'text/html')
  const root = doc.getElementById('store-root')
  return (root?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
}
