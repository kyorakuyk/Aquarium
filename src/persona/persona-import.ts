export interface PersonaImportWarning {
  code: string;
  field?: string;
  message: string;
  excerpt?: string;
}

export interface PersonaImportResponse {
  draft: string;
  mappedCount: number;
  otherCount: number;
  repairCount: number;
  fixedCount: number;
  warnings: PersonaImportWarning[];
}
