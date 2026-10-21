const bn: Record<string, string> = {
  // Language sweep 2026-10-21: Bengali halves of the formerly HARDCODED
  // bilingual UI strings, moved here verbatim (no new copy). The English
  // UI renders the matching keys from en.ts via t() (default locale).
  // Keys whose Bengali counterpart never existed carry the English text
  // in both locales (noted in final-verification/language-sweep-a-ai.md).

  // Contact page + form
  "contact.meta_description":
    "Questions, payment issues or feedback? Contact the Ride Bangla AI Agent support team by form, email, phone or hotline.",
  "contact.hero_title": "যোগাযোগ করুন",
  "contact.hero_subtitle":
    "প্রশ্ন, পেমেন্ট সমস্যা বা মতামত — নিচের ফর্মটি পূরণ করুন, আমাদের টিম শীঘ্রই উত্তর দেবে।",
  "contact.topic_general": "সাধারণ জিজ্ঞাসা",
  "contact.topic_payment": "পেমেন্ট সমস্যা",
  "contact.topic_technical": "কারিগরি সমস্যা",
  "contact.topic_feedback": "মতামত",
  "contact.max_files": "সর্বোচ্চ ৩টি ফাইল যুক্ত করা যাবে",
  "contact.file_unsupported": "এই ধরনের ফাইল সমর্থিত নয়",
  "contact.file_too_large": "ফাইলটি বড় হয়ে গেছে",
  "contact.video_too_large": "ভিডিওটি বড় — ছোট ক্লিপ পাঠান",
  "contact.file_process_failed": "ফাইলটি প্রসেস করা যায়নি",
  "contact.send_failed": "পাঠানো যায়নি। আবার চেষ্টা করুন।",
  "contact.network_error":
    "নেটওয়ার্ক সমস্যা। সংযোগ চেক করে আবার চেষ্টা করুন।",
  "contact.card_email": "ইমেইল",
  "contact.card_phone": "ফোন",
  "contact.card_hotline": "হটলাইন",
  "contact.sent_title": "বার্তা পাঠানো হয়েছে",
  "contact.sent_body":
    "ধন্যবাদ! আমাদের সাপোর্ট টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে।",
  "contact.back_home": "হোমে ফিরুন",
  "contact.name_label": "নাম",
  "contact.name_placeholder": "আপনার নাম",
  "contact.contact_label": "ইমেইল বা ফোন",
  "contact.topic_label": "বিষয়",
  "contact.reference_label": "পেমেন্ট রেফারেন্স",
  "contact.reference_hint": "পেমেন্টের সময় পাওয়া রেফারেন্স কোডটি দিন",
  "contact.message_label": "বার্তা",
  "contact.message_placeholder":
    "আপনার বার্তা বিস্তারিত লিখুন (কমপক্ষে ১০ অক্ষর)",
  "contact.attach_label": "ছবি/ভিডিও যুক্ত করুন",
  "contact.attach_max": "সর্বোচ্চ ৩টি",
  "contact.choose_files": "ফাইল বেছে নিন",
  "contact.compress_note":
    "ছবি স্বয়ংক্রিয়ভাবে ছোট করা হয় (JPEG, ১২৮০px)",
  "contact.sending": "পাঠানো হচ্ছে…",
  "contact.send_message": "বার্তা পাঠান",

  // Onboarding wizard
  "wizard.method_url_title": "আমার ওয়েবসাইট আছে",
  "wizard.method_url_desc":
    "ওয়েবসাইটের ঠিকানা দিন — আমরা আপনার পেজগুলো পড়ে AI-কে ব্যবসা শিখিয়ে দেব।",
  "wizard.method_guided_title": "আমার ওয়েবসাইট নেই",
  "wizard.method_guided_desc":
    "ব্যবসার ধরন বেছে নিয়ে সংক্ষেপে বর্ণনা দিন — AI আপনার জন্য একটি প্রিমিয়াম ল্যান্ডিং পেজ বানিয়ে দেবে; আপনি দেখে অনুমোদন দেবেন।",
  "wizard.category_choose": "বেছে নিন",
  "wizard.category_restaurant": "রেস্টুরেন্ট ও খাবার",
  "wizard.category_fashion": "ফ্যাশন ও পোশাক",
  "wizard.category_grocery": "মুদি ও নিত্যপ্রয়োজনীয়",
  "wizard.category_electronics": "ইলেকট্রনিক্স ও গ্যাজেট",
  "wizard.category_beauty": "বিউটি ও কসমেটিকস",
  "wizard.category_health": "স্বাস্থ্য ও ফার্মেসি",
  "wizard.category_education": "শিক্ষা ও প্রশিক্ষণ",
  "wizard.category_travel": "ভ্রমণ ও পর্যটন",
  "wizard.category_real_estate": "রিয়েল এস্টেট",
  "wizard.category_home_services": "হোম সার্ভিস",
  "wizard.category_automotive": "অটোমোটিভ",
  "wizard.category_other": "অন্যান্য",
  "wizard.method_heading": "আপনার ব্যবসার ওয়েবসাইট আছে?",
  "wizard.method_subtitle":
    "একটি বেছে নিন — AI সেখান থেকে শিখে আপনার গ্রাহকদের উত্তর দেবে।",
  "wizard.category_label": "ব্যবসার ধরন",
  "wizard.category_custom_placeholder": "আপনার ব্যবসার ধরন লিখুন",
  "wizard.landing_note":
    "পেজটি আপনার দেওয়া তথ্য থেকে একটি প্রিমিয়াম টেমপ্লেটে তৈরি হয় — আপনার কোনো API কী লাগবে না; AI-এর সব সংযোগ আমাদের টিমই করে দেবে।",

  // Done-for-You Setup application
  "setup.contact_whatsapp_desc": "হোয়াটসঅ্যাপ",
  "setup.contact_phone_desc": "ফোন কল",
  "setup.contact_email_desc": "ইমেইল",
  "setup.request_subtitle":
    "আমাদের টিম আপনার সাথে যোগাযোগ করে সব সেটআপ করে দেবে — আপনাকে কিছুই করতে হবে না।",
  "setup.business_label": "ব্যবসা",
  "setup.contact_label": "যোগাযোগ",
  "setup.channels_label": "যেসব চ্যানেল যুক্ত করতে হবে",
  "setup.notes_label": "নোট",
  "setup.received_body":
    "আপনার আবেদন আমাদের কাছে পৌঁছেছে। আমাদের টিম শীঘ্রই আপনার পছন্দের মাধ্যমে যোগাযোগ করবে — তারপর Facebook, WhatsApp, Instagram সহ সবকিছু আমাদের টিম নিজে সেটআপ করে দেবে।",
  "setup.form_subtitle":
    "আপনার তথ্য দিন — বাকিটা আমাদের টিম করবে। কোনো API key বা টেকনিক্যাল সেটিংস আপনার লাগবে না।",
  "setup.business_name_label": "ব্যবসার নাম",
  "setup.your_name_label": "আপনার নাম",
  "setup.phone_label": "ফোন / হোয়াটসঅ্যাপ",
  "setup.email_label": "ইমেইল",
  "setup.anything_else_label": "আর কিছু জানাতে চান?",
  "setup.channels_question": "কোন কোন চ্যানেল যুক্ত করবো?",
  "setup.channels_empty_note":
    "কিছু না বাছলেও সমস্যা নেই — আমাদের টিম আপনার সাথে কথা বলে সব ঠিক করে দেবে।",
  "setup.contact_question": "আমরা কীভাবে যোগাযোগ করবো?",

  // Profile
  "profile.saved_toast": "প্রোফাইল সেভ হয়েছে।",
  "profile.name_label": "নাম",
  "profile.email_label": "ইমেইল",
  "profile.contact_name_label": "নাম",
  "profile.phone_label": "ফোন",
  "profile.address_label": "ঠিকানা",
  "profile.photo_title": "প্রোফাইল ছবি",
  "profile.change_photo": "ছবি বদলান",
  "profile.upload_photo": "ছবি আপলোড করুন",
  "profile.crop_note":
    "ছবি বেছে নিলে ক্রপ স্ক্রিন আসবে — আপনার মুখটা মাঝখানে রেখে সেভ করুন।",
  "profile.contact_details_title": "যোগাযোগের তথ্য",
  "profile.save_button": "সেভ করুন",

  // Reviews section
  "reviews.name_required": "আপনার নাম লিখুন",
  "reviews.text_required": "আপনার রিভিউ লিখুন",
  "reviews.post_failed": "রিভিউ পাঠানো যায়নি — আবার চেষ্টা করুন",
  "reviews.post_success": "ধন্যবাদ! আপনার রিভিউ প্রকাশ হয়েছে",
  "reviews.post_failed_network":
    "রিভিউ পাঠানো যায়নি — ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন",
  "reviews.heading": "গ্রাহকদের ভালোবাসা",
  "reviews.subheading":
    "রাইড বাংলা এআই এজেন্ট ব্যবহার করা ব্যবসাগুলোর আসল রিভিউ।",
  "reviews.count_one": "{count} টি রিভিউ",
  "reviews.count_other": "{count} টি রিভিউ",
  "reviews.empty": "এখনো কোনো রিভিউ নেই — প্রথম রিভিউটা আপনিই লিখুন।",
  "reviews.verified_badge": "যাচাইকৃত Google অ্যাকাউন্ট",
  "reviews.write_heading": "রিভিউ লিখুন",
  "reviews.your_name": "আপনার নাম",
  "reviews.your_rating": "আপনার রেটিং",
  "reviews.your_review": "আপনার রিভিউ",
  "reviews.post_button": "রিভিউ পোস্ট করুন",
  "reviews.signin_prompt": "রিভিউ লিখতে সাইন ইন করুন।",

  // Signup
  "signup.google_note": "গুগল দিয়ে এক ট্যাপে অ্যাকাউন্ট খুলুন — কোনো ফর্ম নেই।",
  "signup.no_api_key_note":
    "আপনার কোনো API key লাগবে না — আমাদের টিম সব সেটআপ করে দেবে।",

  // Settings (English counterpart already renders in place as JSX with an
  // inline Link; the Bengali text is preserved here as the bn resource)
  "settings.team_managed_note":
    "আপনার কোনো API key লাগবে না — AI সংযোগ ও মডেল আমাদের টিমই পরিচালনা করে। কিছু বদলাতে হলে Done-for-You Setup থেকে জানান, আমরাই করে দেব।",
  "settings.team_setup_note":
    "নিজে সেটআপ করতে না চাইলে Done-for-You Setup থেকে আবেদন করুন — আমাদের টিম সব করে দেবে।",

  // Landing settings / Channels / Websites / Setup CTA
  "landing.logo_label": "লোগো",
  "channels.no_api_keys_title": "আপনার কোনো API key লাগবে না",
  "websites.intro":
    "আপনার সব ওয়েবসাইট যোগ করুন — এজেন্ট প্রতিটি সাইট থেকে আপনার ব্যবসার বিবরণ শিখবে।",
  "websites.no_website_note":
    "ওয়েবসাইট না থাকলে আমাদের IT টিম আপনার জন্য তৈরি করে দেবে",
  "cta.received_body": "আমাদের টিম যোগাযোগ করে সব চ্যানেল যুক্ত করে দেবে।",
  "cta.apply_body": "আপনার কোনো API key লাগবে না — সব সেটআপ আমাদের টিম করে দেবে।",
};

export default bn;
