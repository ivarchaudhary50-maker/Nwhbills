// ============================================================
// NON-BLOCKING DOM CAPTURE & DOWNLOAD ENGINE (PDF & IMAGE)
// ============================================================
function downloadElementAsImage(targetElement, filename, callback) {
    if (!targetElement) {
        alert("Error: Element to capture was not found.");
        if (callback) callback();
        return;
    }

    const options = {
        scale: 2, // High resolution crisp text
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        width: targetElement.offsetWidth || targetElement.scrollWidth,
        height: targetElement.offsetHeight || targetElement.scrollHeight
    };

    html2canvas(targetElement, options).then(function (canvas) {
        if (canvas.width === 0 || canvas.height === 0) {
            alert("Error: Generated image is empty.");
            if (callback) callback();
            return;
        }

        // Check if output target is a PDF or PNG
        if (filename.toLowerCase().endsWith('.pdf') && window.jspdf) {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
            
            pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, pdfWidth, pdfHeight);
            
            const pdfBlob = pdf.output('blob');
            const url = URL.createObjectURL(pdfBlob);
            const link = document.createElement('a');
            link.download = filename;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            if (callback) callback();
        } else {
            // PNG Blob Download Fallback
            canvas.toBlob(function (blob) {
                if (!blob) {
                    alert("Error creating PNG blob.");
                    if (callback) callback();
                    return;
                }
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = filename;
                link.href = url;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                if (callback) callback();
            }, 'image/png');
        }
    }).catch(function (error) {
        console.error("Capture error:", error);
        alert("Error saving document: " + error.message);
        if (callback) callback();
    });
}
