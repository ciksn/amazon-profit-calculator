UPDATE countries
SET vat_rate = 5,
    tax_rate = 0,
    tax_basis = 'none',
    tax_note = '标准 VAT 5%；从顾客支付的含税售价中按 5/105 拆分',
    source_note = '阿联酋联邦税务局；汇率为可编辑估算值',
    updated_at = now()
WHERE code = 'AE';

UPDATE countries
SET vat_rate = 15,
    tax_rate = 0,
    tax_basis = 'none',
    tax_note = '标准 VAT 15%；从顾客支付的含税售价中按 15/115 拆分',
    source_note = '沙特税务、关税及海关总局；汇率为可编辑估算值',
    updated_at = now()
WHERE code = 'SA';
