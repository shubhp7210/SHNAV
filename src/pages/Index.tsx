import LiveMapSection from "@/components/LiveMapSection";
import CapabilitiesSection from "@/components/CapabilitiesSection";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    <main className="min-h-screen bg-background overflow-x-hidden">
      <LiveMapSection />
      <CapabilitiesSection />
      <Footer />
    </main>
  );
};

export default Index;
