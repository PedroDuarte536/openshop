import type { NodeType } from '@openshop/renderer';
import { ART_KEYS, ICON_KEYS } from '@openshop/renderer';

export interface Field {
  key: string; label: string;
  kind: 'text' | 'textarea' | 'url' | 'seg' | 'select' | 'toggle' | 'number' | 'icon' | 'art' | 'image' | 'items' | 'category';
  options?: { v: string | number; label: string }[];
  min?: number; max?: number; step?: number; hint?: string;
  itemFields?: Field[]; itemDefault?: Record<string, unknown>; addLabel?: string;
}

const VARIANTS = [{ v: 'solid', label: 'Solid' }, { v: 'outline', label: 'Outline' }, { v: 'soft', label: 'Soft' }, { v: 'ghost', label: 'Ghost' }];
const RATIOS = ['auto', '1/1', '4/3', '3/2', '16/9', '4/5', '3/4'].map((v) => ({ v, label: v === 'auto' ? 'Auto' : v.replace('/', ':') }));

export const PROP_FIELDS = {
  section: [],
  column: [],
  heading: [
    { key: 'text', label: 'Text', kind: 'textarea' },
    { key: 'level', label: 'Level', kind: 'seg', options: [1, 2, 3, 4].map((n) => ({ v: n, label: 'H' + n })) },
    { key: 'grad', label: 'Gradient text', kind: 'toggle' },
  ],
  text: [{ key: 'text', label: 'Text', kind: 'textarea' }],
  image: [
    { key: 'src', label: 'Image', kind: 'image' },
    { key: 'alt', label: 'Alt text', kind: 'text', hint: 'Describe the image for screen readers' },
    { key: 'ratio', label: 'Shape', kind: 'select', options: RATIOS },
    { key: 'fit', label: 'Fit', kind: 'seg', options: [{ v: 'cover', label: 'Fill' }, { v: 'contain', label: 'Fit inside' }] },
  ],
  button: [
    { key: 'label', label: 'Label', kind: 'text' },
    { key: 'href', label: 'Link', kind: 'url' },
    { key: 'variant', label: 'Look', kind: 'seg', options: VARIANTS },
    { key: 'size', label: 'Size', kind: 'seg', options: [{ v: 'sm', label: 'S' }, { v: 'md', label: 'M' }, { v: 'lg', label: 'L' }] },
    { key: 'label2', label: 'Second button label', kind: 'text', hint: 'Leave empty for a single button' },
    { key: 'href2', label: 'Second button link', kind: 'url' },
    { key: 'variant2', label: 'Second button look', kind: 'seg', options: VARIANTS },
  ],
  spacer: [],
  divider: [
    { key: 'line', label: 'Line', kind: 'seg', options: [{ v: 'solid', label: 'Solid' }, { v: 'dashed', label: 'Dashed' }, { v: 'dotted', label: 'Dotted' }] },
    { key: 'weight', label: 'Thickness', kind: 'number', min: 1, max: 8 },
  ],
  iconBox: [
    { key: 'icon', label: 'Icon', kind: 'icon' },
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'text', label: 'Text', kind: 'textarea' },
    { key: 'layout', label: 'Layout', kind: 'seg', options: [{ v: 'top', label: 'Icon on top' }, { v: 'left', label: 'Icon beside' }] },
  ],
  stat: [{ key: 'value', label: 'Number', kind: 'text' }, { key: 'label', label: 'Label', kind: 'text' }],
  testimonial: [
    { key: 'quote', label: 'Quote', kind: 'textarea' }, { key: 'author', label: 'Name', kind: 'text' }, { key: 'role', label: 'Role or place', kind: 'text' },
  ],
  faq: [{
    key: 'items', label: 'Questions', kind: 'items', addLabel: 'Add question', itemDefault: { q: 'New question', a: 'Your answer.' },
    itemFields: [{ key: 'q', label: 'Question', kind: 'text' }, { key: 'a', label: 'Answer', kind: 'textarea' }],
  }],
  gallery: [
    { key: 'cols', label: 'Columns', kind: 'seg', options: [2, 3, 4, 5].map((n) => ({ v: n, label: String(n) })) },
    { key: 'ratio', label: 'Shape', kind: 'select', options: RATIOS },
    { key: 'items', label: 'Images', kind: 'items', addLabel: 'Add image', itemDefault: { art: 'sunset' }, itemFields: [{ key: 'src', label: 'Image', kind: 'image' }] },
  ],
  productGrid: [
    { key: 'source', label: 'Which products', kind: 'seg', options: [{ v: 'catalogue', label: 'From the catalogue' }, { v: 'results', label: "This page's results" }], hint: "On category and search pages, \"This page's results\" shows the matching products." },
    { key: 'categoryId', label: 'Category', kind: 'category' },
    { key: 'limit', label: 'How many', kind: 'number', min: 1, max: 48 },
    { key: 'cols', label: 'Columns', kind: 'seg', options: [2, 3, 4, 5].map((n) => ({ v: n, label: String(n) })) },
    { key: 'paginate', label: 'Show page numbers', kind: 'toggle', hint: 'For "This page\'s results": lets visitors browse every result, page by page.' },
  ],
} as unknown as Record<NodeType, Field[]>;

PROP_FIELDS.productTitle = [{ key: 'level', label: 'Heading level', kind: 'seg', options: [1, 2, 3].map((n) => ({ v: n, label: 'H' + n })) }];
PROP_FIELDS.productPrice = [];
PROP_FIELDS.productOffers = [{ key: 'heading', label: 'Heading', kind: 'text' }];
PROP_FIELDS.productDescription = [];
PROP_FIELDS.productGallery = [{ key: 'ratio', label: 'Shape', kind: 'select', options: RATIOS }];
PROP_FIELDS.addToCart = [{ key: 'label', label: 'Button text', kind: 'text' }, { key: 'qty', label: 'Show quantity box', kind: 'toggle' }];
PROP_FIELDS.searchBox = [{ key: 'placeholder', label: 'Placeholder', kind: 'text' }, { key: 'button', label: 'Button text', kind: 'text' }];
PROP_FIELDS.dynamicTitle = [
  { key: 'source', label: 'Shows', kind: 'seg', options: [{ v: 'category', label: 'Category name' }, { v: 'search', label: 'Search words' }] },
  { key: 'level', label: 'Heading level', kind: 'seg', options: [1, 2, 3].map((n) => ({ v: n, label: 'H' + n })) },
];
PROP_FIELDS.categoryNav = [{ key: 'layout', label: 'Look', kind: 'seg', options: [{ v: 'pills', label: 'Pills' }, { v: 'list', label: 'List' }] }];
PROP_FIELDS.searchFilters = [
  { key: 'heading', label: 'Heading', kind: 'text' },
  { key: 'layout', label: 'Layout', kind: 'seg', options: [{ v: 'sidebar', label: 'Sidebar' }, { v: 'bar', label: 'Across the page' }] },
  { key: 'category', label: 'Category filter (search page)', kind: 'toggle' },
  { key: 'price', label: 'Price filter', kind: 'toggle' },
  { key: 'availability', label: '"In stock" filter', kind: 'toggle' },
  { key: 'maxValues', label: 'Values shown before "Show all"', kind: 'number', min: 3, max: 20 },
];
PROP_FIELDS.resultsBar = [{ key: 'showCount', label: 'Number of results', kind: 'toggle' }, { key: 'sort', label: 'Sorting', kind: 'toggle' }];
PROP_FIELDS.productSpecs = [{ key: 'heading', label: 'Heading', kind: 'text' }];
PROP_FIELDS.bundleContents = [{ key: 'heading', label: 'Heading', kind: 'text' }, { key: 'images', label: 'Show photos', kind: 'toggle' }];
PROP_FIELDS.productBundles = [
  { key: 'heading', label: 'Heading', kind: 'text' },
  { key: 'limit', label: 'How many', kind: 'number', min: 1, max: 12 },
  { key: 'cols', label: 'Columns', kind: 'seg', options: [2, 3, 4, 5].map((n) => ({ v: n, label: String(n) })) },
];
PROP_FIELDS.productVariants = [
  { key: 'swatches', label: 'Colour swatches', kind: 'toggle', hint: 'When the property values have a colour' },
  { key: 'showSoldOut', label: 'Mark sold-out variants', kind: 'toggle' },
  { key: 'disabledStyle', label: 'Unavailable choices', kind: 'seg', options: [{ v: 'faded', label: 'Faded' }, { v: 'struck', label: 'Crossed out' }] },
];

/** Shown at the top of a widget's Content tab. */
export const NOTES: Partial<Record<NodeType, string>> = {
  productTitle: 'Shows the name of the product being viewed. You see a sample here; visitors see the real product.',
  productPrice: 'Shows the price of the product being viewed. Visitors with a discount see their price, the original price and a badge. Sample sale shown here.',
  productOffers: 'Lists the offers that apply to the product for each visitor: the one applied, where it comes from, and what other offers would cost. Filled in live from your Discounts; sample data here.',
  productDescription: 'Shows the product description. Sample data here.',
  productGallery: "Shows the product's photos. Sample artwork here.",
  addToCart: 'Adds the product being viewed to the cart.',
  searchBox: 'Visitors type here and land on the search results page.',
  dynamicTitle: 'Shows the category name, or the words someone searched for. Sample data here.',
  categoryNav: 'Lists your categories so visitors can browse. Uses your real categories.',
  searchFilters: 'Filters for category and search pages: category, price, availability and the properties you marked "shoppers can filter by it", each with the number of matching products. Sample data here.',
  resultsBar: 'Shows how many products match and lets visitors sort them. Price sorting uses each visitor\'s own prices.',
  productSpecs: 'Lists the product\'s properties marked "shown on the product page". Sample data here.',
  productVariants: 'For products linked as variants: one line per property that tells them apart, one choice per value. A choice opens the product that differs only in that property; otherwise it is shown as unavailable. Sample data here.',
  bundleContents: 'For bundles: the products inside and, for a price you set below their total, what shoppers save. Sample data here.',
  productBundles: 'The visible bundles that contain the product being viewed. Sample data here.',
};

export const ARTS = [...ART_KEYS];
export const ICONS = [...ICON_KEYS];
