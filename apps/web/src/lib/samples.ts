export type SampleAsset = {
  id: string;
  name: string;
  src: string;
  dimensions: string;
  favorite?: boolean;
  recent?: boolean;
};

export const sampleAssets: SampleAsset[] = [
  { id: "bloom", name: "白色茉莉花.svg", src: "/assets/bloom.svg", dimensions: "2400 × 1800", favorite: true, recent: true },
  { id: "leaf", name: "绿植叶片.svg", src: "/assets/interior.svg", dimensions: "1800 × 1200", recent: true },
  { id: "skin", name: "护肤产品图.svg", src: "/assets/skincare.svg", dimensions: "2048 × 1536", favorite: true },
  { id: "citrus", name: "柑橘参考图.svg", src: "/assets/citrus.svg", dimensions: "1600 × 1200", recent: true },
  { id: "mountain", name: "山间湖泊.svg", src: "/assets/mountain.svg", dimensions: "1920 × 1280" },
  { id: "room", name: "光影室内.svg", src: "/assets/interior.svg", dimensions: "1600 × 1200" },
  { id: "detail", name: "自然纹理.svg", src: "/assets/bloom.svg", dimensions: "1200 × 900" },
  { id: "scene", name: "日落海岸.svg", src: "/assets/mountain.svg", dimensions: "1600 × 1200", favorite: true },
  { id: "forest", name: "森林晨雾.svg", src: "/assets/skincare.svg", dimensions: "1920 × 1280" },
  { id: "citrus2", name: "柠檬切片.svg", src: "/assets/citrus.svg", dimensions: "1600 × 1200" },
  { id: "glass", name: "香氛静物.svg", src: "/assets/bloom.svg", dimensions: "1600 × 1200" },
  { id: "mountain2", name: "雪山日照.svg", src: "/assets/mountain.svg", dimensions: "1920 × 1280" },
];

export const sampleProjects = [
  { id: "spring", title: "春季灵感板", updated: "今天 14:26 修改", art: "art-bloom", image: "/assets/bloom.svg" },
  { id: "story", title: "分镜构思", updated: "昨天 20:13 修改", art: "art-mountain", image: "/assets/mountain.svg" },
  { id: "brand", title: "品牌视觉探索", updated: "4月20日 10:08 修改", art: "art-brand", image: "/assets/skincare.svg" },
];
