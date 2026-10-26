import Foundation
import Vision
import PDFKit
import AppKit

let path = CommandLine.arguments[1]
guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fputs("Could not open PDF\n", stderr); exit(2) }
let selected = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) : nil
let indices: [Int] = selected.map { [$0] } ?? Array(0..<doc.pageCount)
for index in indices {
    guard index >= 0, index < doc.pageCount, let page = doc.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let image = page.thumbnail(of: CGSize(width: max(1600, bounds.width * 2), height: max(1600, bounds.height * 2)), for: .mediaBox)
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["th-TH", "en-US"]
    try VNImageRequestHandler(cgImage: cgImage).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    print(lines.joined(separator: "\n"))
}
