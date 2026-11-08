// Contrato WSDL 1.1 (SOAP, estilo document/literal) del servicio de facturación. Se sirve en GET /soap?wsdl
export const NS = 'urn:descubre-ec:invoicing:v1';
export const wsdl = (location) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}" targetNamespace="${NS}" name="InvoicingService">
  <types>
    <xs:schema targetNamespace="${NS}" elementFormDefault="qualified">
      <xs:complexType name="Cliente"><xs:sequence>
        <xs:element name="tipo_identificacion" type="xs:string"/><xs:element name="identificacion" type="xs:string"/><xs:element name="razon_social" type="xs:string"/>
        <xs:element name="correo" type="xs:string"/><xs:element name="telefono" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType>
      <xs:complexType name="DetalleEntrada"><xs:sequence>
        <xs:element name="det_id" type="xs:long"/><xs:element name="codigo" type="xs:string"/><xs:element name="descripcion" type="xs:string"/><xs:element name="cantidad" type="xs:int"/>
        <xs:element name="precio_unitario" type="xs:decimal"/><xs:element name="descuento" type="xs:decimal" minOccurs="0"/></xs:sequence></xs:complexType>
      <xs:complexType name="Detalle"><xs:sequence>
        <xs:element name="det_id" type="xs:long"/><xs:element name="codigo" type="xs:string"/><xs:element name="descripcion" type="xs:string"/><xs:element name="cantidad" type="xs:int"/>
        <xs:element name="precio_unitario" type="xs:decimal"/><xs:element name="descuento" type="xs:decimal"/><xs:element name="subtotal" type="xs:decimal"/>
        <xs:element name="iva_porcentaje" type="xs:decimal"/><xs:element name="iva" type="xs:decimal"/><xs:element name="total" type="xs:decimal"/></xs:sequence></xs:complexType>
      <xs:complexType name="Factura"><xs:sequence>
        <xs:element name="fac_id" type="xs:long"/><xs:element name="ord_id" type="xs:long"/><xs:element name="numero" type="xs:string"/><xs:element name="clave_acceso" type="xs:string"/>
        <xs:element name="autorizacion_sri" type="xs:string"/><xs:element name="ambiente" type="xs:string"/><xs:element name="estado" type="xs:string"/><xs:element name="emitida_en" type="xs:dateTime"/>
        <xs:element name="cliente" type="tns:Cliente"/><xs:element name="subtotal" type="xs:decimal"/><xs:element name="descuento" type="xs:decimal"/><xs:element name="iva" type="xs:decimal"/>
        <xs:element name="total" type="xs:decimal"/><xs:element name="detalles"><xs:complexType><xs:sequence><xs:element name="detalle" type="tns:Detalle" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element></xs:sequence></xs:complexType>
      <xs:element name="EmitirFacturaRequest"><xs:complexType><xs:sequence>
        <xs:element name="ord_id" type="xs:long"/><xs:element name="dfa_id" type="xs:long" minOccurs="0"/><xs:element name="cliente" type="tns:Cliente" minOccurs="0"/>
        <xs:element name="detalles"><xs:complexType><xs:sequence><xs:element name="detalle" type="tns:DetalleEntrada" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element>
      <xs:element name="EmitirFacturaResponse"><xs:complexType><xs:sequence><xs:element name="factura" type="tns:Factura"/><xs:element name="repetida" type="xs:boolean"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="ConsultarFacturaRequest"><xs:complexType><xs:sequence><xs:element name="fac_id" type="xs:long" minOccurs="0"/><xs:element name="ord_id" type="xs:long" minOccurs="0"/><xs:element name="numero" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="ConsultarFacturaResponse"><xs:complexType><xs:sequence><xs:element name="factura" type="tns:Factura"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="ListarFacturasRequest"><xs:complexType><xs:sequence><xs:element name="estado" type="xs:string" minOccurs="0"/><xs:element name="desde" type="xs:date" minOccurs="0"/><xs:element name="hasta" type="xs:date" minOccurs="0"/>
        <xs:element name="page" type="xs:int" minOccurs="0"/><xs:element name="limit" type="xs:int" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="ListarFacturasResponse"><xs:complexType><xs:sequence><xs:element name="total_results" type="xs:int"/><xs:element name="page" type="xs:int"/><xs:element name="limit" type="xs:int"/>
        <xs:element name="factura" type="tns:Factura" minOccurs="0" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="MarcarFacturaPagadaRequest"><xs:complexType><xs:sequence><xs:element name="fac_id" type="xs:long"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="MarcarFacturaPagadaResponse"><xs:complexType><xs:sequence><xs:element name="factura" type="tns:Factura"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="AnularFacturaRequest"><xs:complexType><xs:sequence><xs:element name="fac_id" type="xs:long"/><xs:element name="motivo" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="AnularFacturaResponse"><xs:complexType><xs:sequence><xs:element name="factura" type="tns:Factura"/></xs:sequence></xs:complexType></xs:element>
    </xs:schema>
  </types>
${['EmitirFactura', 'ConsultarFactura', 'ListarFacturas', 'MarcarFacturaPagada', 'AnularFactura'].map((o) => `  <message name="${o}In"><part name="parameters" element="tns:${o}Request"/></message>
  <message name="${o}Out"><part name="parameters" element="tns:${o}Response"/></message>`).join('\n')}
  <portType name="InvoicingPort">
${['EmitirFactura', 'ConsultarFactura', 'ListarFacturas', 'MarcarFacturaPagada', 'AnularFactura'].map((o) => `    <operation name="${o}"><input message="tns:${o}In"/><output message="tns:${o}Out"/></operation>`).join('\n')}
  </portType>
  <binding name="InvoicingBinding" type="tns:InvoicingPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
${['EmitirFactura', 'ConsultarFactura', 'ListarFacturas', 'MarcarFacturaPagada', 'AnularFactura'].map((o) => `    <operation name="${o}"><soap:operation soapAction="${NS}/${o}"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>`).join('\n')}
  </binding>
  <service name="InvoicingService"><port name="InvoicingPort" binding="tns:InvoicingBinding"><soap:address location="${location}"/></port></service>
</definitions>`;
