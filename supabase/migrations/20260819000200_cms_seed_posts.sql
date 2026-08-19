-- ADBZero CMS starter content
-- Safe to re-run: content and translations are upserted by their stable slugs/keys.

insert into public.cms_taxonomies (slug, taxonomy_type, name_i18n)
values
  ('news', 'category', '{"en":"News","ar":"أخبار"}'::jsonb),
  ('tutorials', 'category', '{"en":"Tutorials","ar":"شروحات"}'::jsonb),
  ('android-tools', 'tag', '{"en":"Android Tools","ar":"أدوات أندرويد"}'::jsonb)
on conflict (slug) do update
set taxonomy_type = excluded.taxonomy_type,
    name_i18n = excluded.name_i18n;

insert into public.cms_contents (
  slug, content_type, visibility, status, publish_at, is_homepage
)
values
  (
    'welcome-to-adbzero',
    'news',
    'public',
    'published',
    timezone('utc', now()),
    false
  ),
  (
    'connect-android-device-with-webusb',
    'tutorial',
    'public',
    'published',
    timezone('utc', now()),
    false
  )
on conflict (slug) do update
set content_type = excluded.content_type,
    visibility = excluded.visibility,
    status = excluded.status,
    publish_at = excluded.publish_at;

insert into public.cms_content_i18n (
  content_id, language, title, excerpt, body_html, seo_title, seo_description, json_ld
)
select c.id, v.language, v.title, v.excerpt, v.body_html, v.seo_title, v.seo_description, v.json_ld::jsonb
from public.cms_contents c
join (
  values
    (
      'welcome-to-adbzero', 'en',
      'Welcome to ADBZero',
      'A browser-based Android toolkit for device management, privacy, and debloating.',
      '<p>Welcome to ADBZero, an Android toolkit that brings device management workflows into the browser.</p><p>Use the dashboard to connect a compatible Android device, review its information, and explore privacy-focused tools such as Debloater, De-Google, and Screen Mirror.</p><p>We will publish practical guides and release notes here as the project evolves.</p>',
      'Welcome to ADBZero',
      'Learn what ADBZero offers and how the browser-based Android toolkit is evolving.',
      '{"@context":"https://schema.org","@type":"Article","headline":"Welcome to ADBZero"}'
    ),
    (
      'welcome-to-adbzero', 'ar',
      'مرحباً بك في ADBZero',
      'أدوات أندرويد عبر المتصفح لإدارة الجهاز والخصوصية وإزالة التطبيقات غير الضرورية.',
      '<p>مرحباً بك في ADBZero، مجموعة أدوات لأندرويد تنقل مهام إدارة الجهاز إلى المتصفح.</p><p>استخدم لوحة التحكم لتوصيل جهاز أندرويد متوافق، ومراجعة معلوماته، وتجربة أدوات الخصوصية مثل Debloater وDe-Google وScreen Mirror.</p><p>سننشر هنا شروحات عملية وملاحظات الإصدارات مع تطور المشروع.</p>',
      'مرحباً بك في ADBZero',
      'تعرّف على وظائف ADBZero وتطور مجموعة أدوات أندرويد التي تعمل عبر المتصفح.',
      '{"@context":"https://schema.org","@type":"Article","headline":"مرحباً بك في ADBZero"}'
    ),
    (
      'connect-android-device-with-webusb', 'en',
      'How to Connect an Android Device with WebUSB',
      'A safe checklist for connecting an Android device to ADBZero from a Chromium browser.',
      '<p>ADBZero uses WebUSB to communicate with compatible Android devices from a secure Chromium-based browser.</p><h2>Before you start</h2><ol><li>Use Chrome, Edge, Brave, or another Chromium browser on a desktop computer.</li><li>Enable Developer options and USB debugging on the Android device.</li><li>Use a data-capable USB cable and unlock the device.</li></ol><h2>Connect safely</h2><p>Open the ADBZero app, choose <strong>Connect Device</strong>, select the device shown by the browser, and accept the Android authorization prompt. Only continue when the device identity is familiar to you.</p><h2>If the connection fails</h2><p>Try another cable or USB port, stop any local ADB server that is holding the USB interface, and confirm that the browser is using HTTPS.</p>',
      'How to Connect Android with WebUSB',
      'Follow a practical checklist for connecting an Android device to ADBZero with WebUSB.',
      '{"@context":"https://schema.org","@type":"HowTo","name":"How to Connect an Android Device with WebUSB"}'
    ),
    (
      'connect-android-device-with-webusb', 'ar',
      'كيفية توصيل جهاز أندرويد باستخدام WebUSB',
      'خطوات آمنة لتوصيل جهاز أندرويد بـ ADBZero عبر متصفح Chromium.',
      '<p>يستخدم ADBZero تقنية WebUSB للتواصل مع أجهزة أندرويد المتوافقة من خلال متصفح آمن مبني على Chromium.</p><h2>قبل البدء</h2><ol><li>استخدم Chrome أو Edge أو Brave أو متصفحاً آخر مبنياً على Chromium على جهاز مكتبي.</li><li>فعّل خيارات المطور وتصحيح أخطاء USB في جهاز أندرويد.</li><li>استخدم كابل USB يدعم نقل البيانات وافتح قفل الجهاز.</li></ol><h2>التوصيل بأمان</h2><p>افتح تطبيق ADBZero، اختر <strong>Connect Device</strong>، ثم حدد الجهاز الذي يعرضه المتصفح ووافق على رسالة التفويض في أندرويد. تابع فقط عندما تتأكد من هوية الجهاز.</p><h2>إذا فشل الاتصال</h2><p>جرّب كابلاً أو منفذ USB آخر، وأوقف أي خادم ADB محلي يحتجز واجهة USB، وتأكد من أن المتصفح يعمل عبر HTTPS.</p>',
      'كيفية توصيل أندرويد عبر WebUSB',
      'اتبع خطوات عملية لتوصيل جهاز أندرويد بـ ADBZero باستخدام WebUSB.',
      '{"@context":"https://schema.org","@type":"HowTo","name":"كيفية توصيل جهاز أندرويد باستخدام WebUSB"}'
    )
) as v(slug, language, title, excerpt, body_html, seo_title, seo_description, json_ld)
  on c.slug = v.slug
on conflict (content_id, language) do update
set title = excluded.title,
    excerpt = excluded.excerpt,
    body_html = excluded.body_html,
    seo_title = excluded.seo_title,
    seo_description = excluded.seo_description,
    json_ld = excluded.json_ld;

insert into public.cms_content_taxonomies (content_id, taxonomy_id)
select c.id, t.id
from public.cms_contents c
join public.cms_taxonomies t on t.slug = case c.slug
  when 'welcome-to-adbzero' then 'news'
  when 'connect-android-device-with-webusb' then 'tutorials'
end
where c.slug in ('welcome-to-adbzero', 'connect-android-device-with-webusb')
on conflict do nothing;

insert into public.cms_content_taxonomies (content_id, taxonomy_id)
select c.id, t.id
from public.cms_contents c
join public.cms_taxonomies t on t.slug = 'android-tools'
where c.slug in ('welcome-to-adbzero', 'connect-android-device-with-webusb')
on conflict do nothing;
Add starter CMS posts
