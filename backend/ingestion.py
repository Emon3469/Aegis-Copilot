from pathlib import Path

from src.config import get_settings
from src.ingestion import ingest_directory, list_documents
from src.vectorstore import get_backends

DOCUMENTS_DIR = Path(__file__).resolve().parent / "documents"


def main():
    s = get_settings()
    backends = get_backends()
    if not backends:
        raise SystemExit("No embedding backend configured. Set PINECONE_API_KEY (and optionally OPENAI_API_KEY).")

    print("=" * 64)
    print("Aegis Copilot - knowledge base ingestion")
    print("=" * 64)
    for b in backends:
        print(f"{b.name:<9} model={b.model} dim={b.dimension} index={b.index_name}")
    print(f"namespace  {s.pinecone_namespace}")
    print(f"documents  {DOCUMENTS_DIR}")
    print()

    files = list_documents(DOCUMENTS_DIR)
    if not files:
        print("No supported documents found in ./documents")
        return
    for path in files:
        print(f"  - {path.name}")

    written = ingest_directory(DOCUMENTS_DIR)
    print()
    for name, count in written.items():
        print(f"{name}: {count} chunks indexed")


if __name__ == "__main__":
    main()
