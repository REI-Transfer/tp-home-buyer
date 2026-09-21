// Thank-you video library, grouped into accordion categories. Data-driven so the
// VideoLibrary component (main player + accordion) renders N vertical (9:16) videos.
// URLs are the verbatim Vercel Blob `url` values from TP's blob store.
export interface VideoItem { id: string; title: string; url: string }
export interface VideoCategory { category: string; videos: VideoItem[] }

export const VIDEO_LIBRARY: VideoCategory[] = [
  {
    category: "Start Here",
    videos: [
      { id: "v-welcome", title: "Thank You for Filling Out the Form", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/thank%20you%20for%20filling%20form.mp4" },
      { id: "v-who", title: "Who We Are", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/who%20are%20we.mp4" },
      { id: "v-booked", title: "Call Booked \u2014 What's Next", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/call%20booked.%20what%20next.mp4" },
    ],
  },
  {
    category: "How Our Offers Work",
    videos: [
      { id: "v-vs", title: "Cash Offer vs. Realtor", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/cash%20offer%20vs%20realtor.mp4" },
      { id: "v-notevery", title: "Why We Don't Buy Every House", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/we%20dont%20buy%20every%20house.mp4" },
    ],
  },
  {
    category: "Before Your Call",
    videos: [
      { id: "v-smoother", title: "3 Things to Make Your Call Smoother", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/3%20things%20to%20make%20call%20smoother.mp4" },
      { id: "v-noobl", title: "No Obligations", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/no%20obligations.mp4" },
    ],
  },
  {
    category: "Real Stories",
    videos: [
      { id: "v-stories", title: "Real Stories", url: "https://p06pp8fxix6xz4m1.public.blob.vercel-storage.com/typ-videos/stories.mp4" },
    ],
  },
];
